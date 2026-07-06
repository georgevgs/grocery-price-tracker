import { useEffect, useState, type ReactNode } from 'react';

interface ProductImageProps {
  /** Hotlinked retailer shot; null/absent falls straight through to the placeholder. */
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** The existing placeholder — shown when there is no image or the hotlink 404s. */
  fallback: ReactNode;
}

/**
 * Renders a product shot, falling back to the given placeholder when the
 * product has no image or the retailer CDN rejects the hotlink (404 /
 * hotlink protection). The `failed` flag resets when `src` changes so a
 * broken image on one product doesn't suppress a good one on the next.
 */
export const ProductImage = ({ src, alt, className, fallback }: ProductImageProps) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (null === src || undefined === src || 0 === src.length || true === failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  );
};
