import type { ImgHTMLAttributes } from 'react';
import { useResolvedTheme } from './theme';

/** Load only the artwork for the selected appearance, including manual overrides. */
export function ThemedImage({ light, dark, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & { light: string; dark: string }) {
  const theme = useResolvedTheme();
  return <img {...props} src={theme === 'dark' ? dark : light} />;
}
