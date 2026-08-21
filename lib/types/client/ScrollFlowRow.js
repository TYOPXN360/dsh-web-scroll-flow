import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * General Settings rows for the streaming scroll animation plugin: the
 * animation switch plus the Debug-log switch. Each renders a title/description
 * pair and a switch control; persisted preferences arrive through the injected
 * `enabled` / `debug` hooks, writes through `setEnabled` / `setDebug`.
 */
import clsx from 'clsx';
import css from './ScrollFlowRow.module.css';
/** One switch row: copy pair plus the switch control. */
function SwitchRow({ checked, title, description, onToggle, }) {
    return (_jsxs("div", { className: css.row, children: [_jsxs("div", { className: css.rowText, children: [_jsx("div", { className: css.title, children: title }), _jsx("div", { className: css.desc, children: description })] }), _jsx("button", { type: "button", role: "switch", "aria-checked": checked, className: css.switch, onClick: onToggle, children: _jsx("span", { className: clsx(css.track, checked && css.trackOn), "aria-hidden": "true", children: _jsx("span", { className: css.thumb }) }) })] }));
}
/**
 * Render the streaming scroll animation switch row and the Debug-log switch.
 * @param props - composed Settings slot props.
 * @returns the preference rows.
 */
export function ScrollFlowRow({ useEnabled, useDebug, setEnabled, setDebug, t }) {
    const enabled = useEnabled(value => value);
    const debug = useDebug(value => value);
    return (_jsxs(_Fragment, { children: [_jsx(SwitchRow, { checked: enabled, title: t('settings.title'), description: t('settings.description'), onToggle: () => { setEnabled(!enabled); } }), _jsx(SwitchRow, { checked: debug, title: t('settings.debugTitle'), description: t('settings.debugDescription'), onToggle: () => { setDebug(!debug); } })] }));
}
//# sourceMappingURL=ScrollFlowRow.js.map