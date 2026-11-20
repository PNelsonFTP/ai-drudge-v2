// "?" help overlay: the keyboard map as an accessible modal. Content comes from KEY_BINDING_GROUPS
// so it cannot drift from the reducer.

import { Fragment } from "react";
import { Dialog } from "../features/chrome/Dialog";
import { KEY_BINDING_GROUPS, type KeyBinding } from "./keymap";

function Keys({ binding }: { binding: KeyBinding }) {
  return (
    <>
      {binding.keys.map((key, i) => (
        <Fragment key={key}>
          {i > 0 && <span className="muted"> {binding.join ?? "or"} </span>}
          <kbd>{key}</kbd>
        </Fragment>
      ))}
    </>
  );
}

export interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
  /** False when the reader turned single-key shortcuts off in Settings (default true). */
  enabled?: boolean;
  /** Link to the Settings page, where the switch lives. */
  settingsHref?: string;
}

export function ShortcutsHelp({ open, onClose, enabled = true, settingsHref }: ShortcutsHelpProps) {
  const settings = settingsHref ? (
    <a href={settingsHref} onClick={onClose}>
      Settings
    </a>
  ) : (
    "Settings"
  );
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      {enabled ? (
        <p className="muted">
          Shortcuts are off while you type in a field. Every action is also available with the mouse or by touch. You can turn single-key shortcuts off in {settings}.
        </p>
      ) : (
        <p>
          <strong>Single-key shortcuts are turned off.</strong> Only Esc works. Turn them back on in {settings}.
        </p>
      )}
      {KEY_BINDING_GROUPS.map((group) => (
        <table key={group.title} className="shortcut-table">
          <caption>{group.title}</caption>
          <tbody>
            {group.bindings.map((binding) => (
              <tr key={binding.label}>
                <th scope="row">
                  <Keys binding={binding} />
                </th>
                <td>{binding.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </Dialog>
  );
}
