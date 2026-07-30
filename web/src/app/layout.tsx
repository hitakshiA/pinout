import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Pinout — metered payments for AI agents",
    template: "%s · Pinout",
  },
  description:
    "Agents rent their own compute, pay for it by the second on Hedera with " +
    "x402, and are refunded what they do not use.",
  metadataBase: new URL("https://pinout.club"),
  openGraph: {
    title: "Pinout — metered payments for AI agents",
    description:
      "Agents rent their own compute, pay for it by the second on Hedera, and " +
      "are refunded what they do not use.",
    url: "https://pinout.club",
    siteName: "Pinout",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
