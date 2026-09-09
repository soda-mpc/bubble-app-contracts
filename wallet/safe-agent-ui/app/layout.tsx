import type { Metadata } from "next";
import "@rainbow-me/rainbowkit/styles.css";
import "~~/styles/globals.css";
import { ThemeProvider } from "~~/components/ThemeProvider";
import { AppProviders } from "~~/components/AppProviders";

export const metadata: Metadata = {
  title: "Safe Agent UI",
  description: "Safe issuer demo: agents, anonymous notes, cash out to clear",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="data-theme" defaultTheme="light" enableSystem>
          <AppProviders>{children}</AppProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
