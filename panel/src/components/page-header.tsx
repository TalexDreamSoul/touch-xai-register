"use client";

import { Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Text variant="heading2" as="h1">
          {title}
        </Text>
        {description ? (
          <Text variant="secondary" size="sm">
            {description}
          </Text>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
