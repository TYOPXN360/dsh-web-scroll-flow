/**
 * Scroll-flow settings section: one dedicated menu entry under Settings that
 * hosts the streaming scroll animation switch and the Debug-log switch. The
 * section renders its own page chrome (heading + rows); the nav label arrives
 * from the registrant via `section.nav`.
 */
import clsx from 'clsx'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ScrollFlowSection.module.css'

/** Registration-side preference face shared by the section and the behavior. */
export interface ScrollFlowSectionInjected {
  hooks: {
    /** Persisted streaming-animation preference bound as useEnabled. */
    enabled: SnapshotStore<boolean>
    /** Persisted Debug-logging preference bound as useDebug. */
    debug: SnapshotStore<boolean>
  }
  /** Change the streaming-animation preference. */
  setEnabled: (enabled: boolean) => void
  /** Change the Debug-logging preference. */
  setDebug: (enabled: boolean) => void
}

/** Full Settings-section props. */
export type ScrollFlowSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'scrollFlow'>
  & InjectFace<ScrollFlowSectionInjected>

/** One preference row: copy pair plus the switch control. */
function SwitchRow({
  checked, title, description, onToggle,
}: {
  checked: boolean
  title: string
  description: string
  onToggle: () => void
}) {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{title}</div>
        <div className={css.desc}>{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={css.switch}
        onClick={onToggle}
      >
        <span className={clsx(css.track, checked && css.trackOn)} aria-hidden="true">
          <span className={css.thumb} />
        </span>
      </button>
    </div>
  )
}

/**
 * Render the scroll-flow settings page: heading plus the animation and
 * Debug-log switches.
 * @param props - composed Settings slot props.
 * @returns the settings section.
 */
export function ScrollFlowSection({ useEnabled, useDebug, setEnabled, setDebug, t }: ScrollFlowSectionProps) {
  const enabled = useEnabled(value => value)
  const debug = useDebug(value => value)
  return (
    <div className={css.section}>
      <div className={css.heading}>{t('section.nav')}</div>
      <div className={css.rows}>
        <SwitchRow
          checked={enabled}
          title={t('settings.title')}
          description={t('settings.description')}
          onToggle={() => { setEnabled(!enabled) }}
        />
        <SwitchRow
          checked={debug}
          title={t('settings.debugTitle')}
          description={t('settings.debugDescription')}
          onToggle={() => { setDebug(!debug) }}
        />
      </div>
    </div>
  )
}
