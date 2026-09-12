import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * Without this, mobile Safari renders the page at 980px and scales it down —
 * every touch target shrinks below usable size and the type goes illegible.
 * Next injects a default, but declaring it makes the intent explicit and
 * lets us pin maximumScale so iOS does not zoom on input focus.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "refcentral — Premier League referee analysis",
  description:
    "Premier League refereeing decisions, rated one call at a time. Every weighting is explained by a fact about the match.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;800&family=Archivo+Narrow:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
