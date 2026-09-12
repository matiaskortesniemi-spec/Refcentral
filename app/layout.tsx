import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * Without this, mobile Safari renders the page at 980px and scales it down —
 * every touch target shrinks below usable size and the type goes illegible.
 *
 * Note the absence of viewport-fit: cover. It extends content into the
 * display's safe area, which on a notched phone pushes the header out to the
 * physical edges of the screen. Wanted for a full-bleed image, wrong for a
 * page whose content should sit inside a gutter.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
