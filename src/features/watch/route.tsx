import "../export/kit/kit.css";
import type { RouteModule } from "../../app/services";
import { WatchPage } from "./WatchPage";

const route: RouteModule = { name: "watch", Component: WatchPage, title: "Watchlist" };

export default route;
