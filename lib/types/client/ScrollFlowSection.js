import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Scroll-flow settings section: one dedicated menu entry under Settings that
 * hosts the streaming scroll animation switch and the Debug-log switch. The
 * section renders its own page chrome (heading + rows); the nav label arrives
 * from the registrant via `section.nav`.
 */
import clsx from 'clsx';
import css from './ScrollFlowSection.module.css';
/** One preference row: copy pair plus the switch control. */
function SwitchRow({ checked, title, description, onToggle, }) {
    return (_jsxs("div", { className: css.row, children: [_jsxs("div", { className: css.rowText, children: [_jsx("div", { className: css.title, children: title }), _jsx("div", { className: css.desc, children: description })] }), _jsx("button", { type: "button", role: "switch", "aria-checked": checked, className: css.switch, onClick: onToggle, children: _jsx("span", { className: clsx(css.track, checked && css.trackOn), "aria-hidden": "true", children: _jsx("span", { className: css.thumb }) }) })] }));
}
/**
 * Render the scroll-flow settings page: heading plus the animation and
 * Debug-log switches.
 * @param props - composed Settings slot props.
 * @returns the settings section.
 */
export function ScrollFlowSection({ useEnabled, useDebug, setEnabled, setDebug, t }) {
    const enabled = useEnabled(value => value);
    const debug = useDebug(value => value);
    return (_jsxs("div", { className: css.section, children: [_jsx("div", { className: css.heading, children: t('section.nav') }), _jsxs("div", { className: css.rows, children: [_jsx(SwitchRow, { checked: enabled, title: t('settings.title'), description: t('settings.description'), onToggle: () => { setEnabled(!enabled); } }), _jsx(SwitchRow, { checked: debug, title: t('settings.debugTitle'), description: t('settings.debugDescription'), onToggle: () => { setDebug(!debug); } })] })] }));
}
//# sourceMappingURL=ScrollFlowSection.js.map