interface ErrorNoticeProps {
  /** One line per message. Empty array renders nothing. */
  messages: string[];
  /**
   * 'danger' (red) for blocking failures, 'warn' (amber) for non-fatal
   * per-chain search hiccups that still let the rest of the search through.
   * Defaults to 'danger'.
   */
  tone?: 'danger' | 'warn';
}

/**
 * Full class strings per tone, written out literally so Tailwind's source
 * scanner emits them (it can't see runtime-concatenated names).
 */
const TONE_STYLES = {
  danger: { box: 'border-danger bg-danger/10', text: 'text-danger' },
  warn: { box: 'border-warn bg-warn/10', text: 'text-warn' },
} as const;

/**
 * A contained, self-wrapping error box. Technical strings (raw URLs,
 * `[retailer] HTTP 403 …`) have no spaces to break on, so without this they
 * overflow their card and — because a flex item keeps `min-width: auto` — set
 * the whole layout's width, pushing the page sideways on a phone. The
 * `min-w-0` + `break-words` pair lets the item shrink and forces long tokens
 * to wrap inside the box instead of dictating the width.
 */
export const ErrorNotice = ({ messages, tone = 'danger' }: ErrorNoticeProps) => {
  if (0 === messages.length) {
    return null;
  }

  const style = TONE_STYLES[tone];

  return (
    <div
      className={`flex min-w-0 max-w-full flex-col gap-1.5 rounded-xl border-2 px-3.5 py-2.5 ${style.box}`}
    >
      {messages.map((message, index) => (
        <p key={`${index}-${message}`} className={`flex items-start gap-2 text-sm ${style.text}`}>
          <span aria-hidden className="mt-px flex-none font-mono font-bold leading-none">
            !
          </span>
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message}</span>
        </p>
      ))}
    </div>
  );
};
