"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  BroadcastIcon,
  CloudArrowUpIcon,
  DownloadSimpleIcon,
  GearIcon,
  HouseIcon,
  NetworkIcon,
  PlayCircleIcon,
  SignOutIcon,
  StackIcon,
} from "@phosphor-icons/react";
import {
  Button,
  Loader,
  Sidebar,
  Surface,
  Text,
} from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";

type NavItem = {
  href: string;
  label: string;
  icon: typeof HouseIcon;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: "工作台",
    items: [
      { href: "/", label: "概览", icon: HouseIcon },
      { href: "/register", label: "注册", icon: PlayCircleIcon },
    ],
  },
  {
    label: "凭证",
    items: [
      { href: "/upload", label: "上传", icon: CloudArrowUpIcon },
      { href: "/export", label: "导出", icon: DownloadSimpleIcon },
      { href: "/pool", label: "号池", icon: StackIcon },
    ],
  },
  {
    label: "联邦",
    items: [{ href: "/cluster", label: "主从", icon: NetworkIcon }],
  },
  {
    label: "状态页",
    items: [
      { href: "/status", label: "公开看板", icon: BroadcastIcon },
      { href: "/status-admin", label: "看板配置", icon: GearIcon },
    ],
  },
  {
    label: "系统",
    items: [{ href: "/settings", label: "设置", icon: GearIcon }],
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { loading, authed, logout } = useAuth();

  if (loading) {
    return (
      <Surface className="flex min-h-screen items-center justify-center gap-2">
        <Loader />
        <Text variant="secondary">加载中…</Text>
      </Surface>
    );
  }

  if (!authed) {
    if (typeof window !== "undefined" && pathname !== "/login/") {
      router.replace("/login/");
    }
    return (
      <Surface className="flex min-h-screen items-center justify-center">
        <Text variant="secondary">跳转登录…</Text>
      </Surface>
    );
  }

  return (
    <Sidebar.Provider defaultOpen className="min-h-screen">
      <Sidebar className="flex h-screen flex-col">
        <Sidebar.Header className="!flex !w-full !items-center !justify-between !gap-2">
          <div className="min-w-0 flex-1">
            <Text variant="heading3" as="span">
              Grok Panel
            </Text>
            <Text variant="secondary" size="xs">
              注册 · CPA · 状态
            </Text>
          </div>
          <Sidebar.Trigger className="shrink-0" />
        </Sidebar.Header>

        <Sidebar.Content className="flex-1 overflow-y-auto">
          {navGroups.map((group) => (
            <Sidebar.Group key={group.label}>
              <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {group.items.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/" || pathname === ""
                      : pathname === item.href ||
                        pathname.startsWith(`${item.href}/`);
                  return (
                    <Sidebar.MenuItem key={item.href}>
                      <Sidebar.MenuButton
                        icon={item.icon}
                        active={active}
                        onClick={() => router.push(item.href)}
                      >
                        {item.label}
                      </Sidebar.MenuButton>
                    </Sidebar.MenuItem>
                  );
                })}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>

        <Sidebar.Footer className="!h-auto !min-h-0 !w-full !flex-col !items-stretch !gap-2 !overflow-visible !px-2 !py-2">
          <Button
            variant="ghost"
            size="sm"
            className="!w-full !justify-start"
            onClick={() => {
              logout();
              router.replace("/login/");
            }}
          >
            <SignOutIcon size={16} /> 退出登录
          </Button>
        </Sidebar.Footer>
      </Sidebar>

      <main className="min-h-screen flex-1 overflow-auto p-6">{children}</main>
    </Sidebar.Provider>
  );
}
