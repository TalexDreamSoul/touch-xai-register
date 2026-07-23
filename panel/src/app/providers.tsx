"use client";

import { Toasty } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Toasty>{children}</Toasty>
      </AuthProvider>
    </ThemeProvider>
  );
}
