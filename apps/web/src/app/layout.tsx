import './globals.css';
import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'AI SDLC Orchestrator' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">{children}</body>
    </html>
  );
}
