import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChunkScope — Zarr storage inspector",
  description: "Explore scientific volumes and observe real chunk access.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
