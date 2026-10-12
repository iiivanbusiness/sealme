import AppShell from "@/components/AppShell";
import { phoneAppViewport } from "@/lib/phone-app-server";

export const generateViewport = phoneAppViewport;

export default function AppSectionLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
