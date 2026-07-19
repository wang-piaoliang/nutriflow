import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriFlow",
  description: "每日摄入、采购历史和食材营养库",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
