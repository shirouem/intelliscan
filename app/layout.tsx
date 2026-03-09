import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Paper Scanner",
  description: "Scan question papers and extract text using AI Vision",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
