interface ErrorNoticeProps {
  /** One line per message. Empty array renders nothing. */
  messages: string[];
}

/**
 * A contained, self-wrapping error box. Technical strings (raw URLs,
 * `[retailer] HTTP 500 …`) have no spaces to break on, so without this they
 * overflow their card and push the whole page sideways on a phone. The
 * `min-w-0` + `break-words` pair forces long tokens to wrap inside the box
 * instead of setting the layout's width.
 */
export const ErrorNotice = ({ messages }: ErrorNoticeProps) => {
  if (0 === messages.length) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border-2 border-danger bg-danger/10 px-3.5 py-2.5">
      {messages.map((message) => (
        <p key={message} className="flex items-start gap-2 text-sm text-danger">
          <span aria-hidden className="mt-px flex-none font-mono font-bold leading-none">
            !
          </span>
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message}</span>
        </p>
      ))}
    </div>
  );
};
