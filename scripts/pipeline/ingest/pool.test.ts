import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_OVERRIDES, HostPool, hostKey, Semaphore, TimeoutBreaker, HostBackoff, isHostTrouble, DEFAULT_HOST_BACKOFF_AFTER } from "./pool";
import { createVirtualClock } from "./testing/virtualClock";
import { createDeadline, sleep } from "./timers";

describe("Semaphore", () => {
  it("is FIFO and hands slots over without exceeding max", async () => {
    const s = new Semaphore(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const release = await s.acquire();
        active++;
        peak = Math.max(peak, active);
        order.push(n);
        await new Promise((r) => setImmediate(r));
        active--;
        release();
        release(); // double release is a no-op
      }),
    );
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.equal(s.inFlight, 0);
  });
});

describe("HostPool", () => {
  it("caps concurrency per host key and overall", async () => {
    const clock = createVirtualClock();
    const pool = new HostPool({ perHost: 2, perHostOverrides: {}, maxTotal: 3 });
    const active = new Map<string, number>();
    const peakByHost = new Map<string, number>();
    let total = 0;
    let peakTotal = 0;
    const task = (host: string) =>
      pool.run(host, async () => {
        active.set(host, (active.get(host) ?? 0) + 1);
        total++;
        peakByHost.set(host, Math.max(peakByHost.get(host) ?? 0, active.get(host) ?? 0));
        peakTotal = Math.max(peakTotal, total);
        await sleep(clock, 100);
        active.set(host, (active.get(host) ?? 0) - 1);
        total--;
      });
    const all = Promise.all(["a", "a", "a", "a", "b", "b", "b", "c", "d", "e"].map(task));
    await clock.settle(all);
    assert.deepEqual([...peakByHost.values()].every((n) => n <= 2), true);
    assert.equal(peakByHost.get("a"), 2);
    assert.equal(peakTotal, 3);
    assert.equal(pool.peakInFlight, 3);
  });

  it("no head-of-line blocking: a hung host never delays other hosts (virtual clock)", async () => {
    const clock = createVirtualClock();
    // V1's worst case: the hung host's feeds are listed FIRST and outnumber the global limit.
    const pool = new HostPool({ perHost: 2, perHostOverrides: {}, maxTotal: 4 });
    const HANG_MS = 8_000;
    const finishedAt = new Map<string, number>();
    const startedAt = new Map<string, number>();
    const job = (name: string, host: string, ms: number) =>
      pool.run(host, async () => {
        startedAt.set(name, clock.now());
        await sleep(clock, ms);
        finishedAt.set(name, clock.now());
      });

    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) jobs.push(job(`hung-${i}`, "hung.example.com", HANG_MS));
    for (let i = 0; i < 20; i++) jobs.push(job(`fast-${i}`, `fast-${i}.example.com`, 100));
    for (let i = 0; i < 4; i++) jobs.push(job(`shared-${i}`, "busy.example.com", 100));
    const all = Promise.all(jobs);

    // 24 healthy jobs x 100 ms on the 2 global slots the hung host cannot take = 1,200 ms.
    await clock.advance(1_200);
    const healthy = [...finishedAt.entries()].filter(([k]) => !k.startsWith("hung-"));
    assert.equal(healthy.length, 24, "every healthy host is done although 12 hung requests were queued first");
    assert.equal(Math.max(...healthy.map(([, t]) => t)), 1_200);
    assert.equal([...finishedAt.keys()].filter((k) => k.startsWith("hung-")).length, 0);
    // Only 2 hung requests ever hold a slot; the other 10 wait on their HOST, not on the global gate.
    // (With V1's nesting the first 4 hung jobs would own all 4 global slots for 8 s each.)
    assert.equal([...startedAt.keys()].filter((k) => k.startsWith("hung-")).length, 2);

    await clock.settle(all);
    assert.equal(finishedAt.get("hung-11"), 6 * HANG_MS, "the hung host drains 2 at a time, on its own");
  });

  it("a rejected task releases its slots", async () => {
    const pool = new HostPool({ perHost: 1, maxTotal: 1 });
    await assert.rejects(pool.run("a", async () => Promise.reject(new Error("boom"))));
    assert.equal(await pool.run("a", async () => 42), 42);
  });

  it("github.com gets the measured higher cap by default", () => {
    assert.equal(DEFAULT_HOST_OVERRIDES["github.com"], 4);
  });
});

describe("hostKey", () => {
  it("is the bare host, with multi-tenant platforms collapsed to one bucket", () => {
    assert.equal(hostKey("https://www.theverge.com/rss/index.xml"), "theverge.com");
    assert.equal(hostKey("https://thezvi.substack.com/feed"), "substack.com");
    assert.equal(hostKey("https://garymarcus.substack.com/feed"), "substack.com");
    assert.equal(hostKey("https://old.reddit.com/r/LocalLLaMA/.rss"), "reddit.com");
    assert.equal(hostKey("https://www.reddit.com/r/LocalLLM/.rss"), "reddit.com");
    assert.equal(hostKey("https://hnrss.org/newest?q=AI"), "hnrss.org");
    assert.equal(hostKey("https://blogs.nvidia.com/feed/"), "blogs.nvidia.com");
    assert.equal(hostKey("not a url"), "unknown");
  });
});

describe("TimeoutBreaker", () => {
  it("opens after the threshold of timeouts and resets on a response", () => {
    const b = new TimeoutBreaker(3);
    b.recordTimeout("h");
    b.recordTimeout("h");
    assert.equal(b.isOpen("h"), false);
    b.recordTimeout("h");
    assert.equal(b.isOpen("h"), true);
    assert.equal(b.isOpen("other"), false);
    b.recordResponse("h");
    assert.equal(b.isOpen("h"), false);
  });
});

describe("deadline", () => {
  it("expires on the virtual clock and aborts its signal", async () => {
    const clock = createVirtualClock();
    const d = createDeadline(clock, 5_000);
    assert.equal(d.expired(), false);
    assert.equal(d.remaining(), 5_000);
    await clock.advance(4_999);
    assert.equal(d.signal.aborted, false);
    await clock.advance(1);
    assert.equal(d.expired(), true);
    assert.equal(d.signal.aborted, true);
    assert.equal(d.remaining(), 0);
  });

  it("sleep resolves early when the signal aborts", async () => {
    const clock = createVirtualClock();
    const d = createDeadline(clock, 1_000);
    let woke = -1;
    const p = sleep(clock, 60_000, d.signal).then(() => {
      woke = clock.now();
    });
    await clock.settle(p, 5_000);
    assert.equal(woke, 1_000);
  });
});

describe("HostPool minimum gap between starts on one host", () => {
  it("spaces task starts by the host's gap and leaves other hosts alone", async () => {
    let clock = 0;
    const slept: number[] = [];
    const pool = new HostPool({
      perHost: 2,
      minGapMs: { "slow.example": 2000 },
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    const starts: [string, number][] = [];
    const task = (key: string) => pool.run(key, async () => void starts.push([key, clock]));
    await Promise.all([task("slow.example"), task("slow.example"), task("fast.example"), task("slow.example")]);
    // The first start is immediate; the second and third each wait one gap (the fake sleep jumps the clock).
    assert.equal(starts.filter(([k]) => k === "slow.example").length, 3);
    assert.equal(clock, 4000);
    assert.equal(starts.filter(([k]) => k === "fast.example").length, 1);
    assert.deepEqual(slept, [2000, 2000], "only the gapped host ever waits");
  });
});

describe("HostBackoff (5xx / 429 from one host, per run)", () => {
  it("opens after two requests in a row ended in 5xx / 429 and stays open for the run", () => {
    const b = new HostBackoff();
    assert.equal(DEFAULT_HOST_BACKOFF_AFTER, 2);
    assert.equal(b.isOpen("hnrss.org"), false);
    assert.equal(b.describe("hnrss.org"), "");
    assert.equal(b.recordFailure("hnrss.org", 502), false);
    assert.equal(b.isOpen("hnrss.org"), false, "one failing request is a failing URL, not a failing host");
    assert.equal(b.recordFailure("hnrss.org", 502), true, "the call that opens it says so (one log line)");
    assert.equal(b.isOpen("hnrss.org"), true);
    assert.equal(b.describe("hnrss.org"), "hnrss.org answered HTTP 502 to 2 requests in a row");
    assert.equal(b.recordFailure("hnrss.org", 503), false);
    b.recordAnswer("hnrss.org");
    assert.equal(b.isOpen("hnrss.org"), true, "a late answer does not close it: the rest of the run leaves the host alone");
    assert.deepEqual(b.openHosts, ["hnrss.org"]);
    assert.equal(b.isOpen("github.com"), false, "per host key");
  });

  it("an answer in between resets the count: a host that fails for single URLs is never cut off", () => {
    const b = new HostBackoff();
    for (let i = 0; i < 5; i++) {
      assert.equal(b.recordFailure("news.google.com", 503), false);
      b.recordAnswer("news.google.com");
    }
    assert.equal(b.isOpen("news.google.com"), false);
    assert.deepEqual(b.openHosts, []);
  });

  it("threshold is configurable; Infinity disables the backoff", () => {
    const three = new HostBackoff(3);
    three.recordFailure("h", 429);
    three.recordFailure("h", 429);
    assert.equal(three.isOpen("h"), false);
    three.recordFailure("h", 500);
    assert.equal(three.describe("h"), "h answered HTTP 500 to 3 requests in a row");
    const never = new HostBackoff(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 50; i++) never.recordFailure("h", 502);
    assert.equal(never.isOpen("h"), false);
  });

  it("isHostTrouble: 429 and every 5xx; nothing else", () => {
    for (const code of [429, 500, 502, 503, 504, 520, 599]) assert.equal(isHostTrouble(code), true, String(code));
    for (const code of [undefined, 200, 304, 400, 401, 403, 404, 410, 408, 600]) assert.equal(isHostTrouble(code), false, String(code));
  });
});

describe("HostPool: noGap", () => {
  it("a task that will not touch the host neither waits for nor reserves the host's gap", async () => {
    const clock = createVirtualClock();
    const pool = new HostPool({ perHostOverrides: { "slow.example": 1 }, minGapMs: { "slow.example": 1000 }, now: () => clock.now(), sleep: (ms) => sleep(clock, ms) });
    const started: [string, number][] = [];
    const task = (name: string) => async (): Promise<void> => void started.push([name, clock.now()]);
    let skip = false;
    const all = Promise.all([
      pool.run("slow.example", task("a")),
      pool.run("slow.example", async () => {
        started.push(["b", clock.now()]);
        skip = true; // from here on the host is "in backoff"
      }),
      pool.run("slow.example", task("c"), { noGap: () => skip }),
      pool.run("slow.example", task("d"), { noGap: () => skip }),
    ]);
    await clock.settle(all);
    assert.deepEqual(started, [["a", 0], ["b", 1000], ["c", 1000], ["d", 1000]]);
  });
});
