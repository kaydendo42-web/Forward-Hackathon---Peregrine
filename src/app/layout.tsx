import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Peregrine — compliance collection', description: 'Synthetic family-group evidence collection demonstration.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-AU"><body>{children}</body></html>;
}
