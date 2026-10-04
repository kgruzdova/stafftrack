import type { Metadata } from "next";
import "./globals.css";
import "./stafftrack.css";

export const metadata: Metadata = {
  title: "StaffTrack — задачи и мотивация команды",
  description: "Задачи, сроки, проверка результатов, баллы и награды вашей команды.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
