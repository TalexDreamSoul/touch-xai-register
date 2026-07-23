"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  CloudArrowUpIcon,
  DownloadSimpleIcon,
  GearIcon,
  HouseIcon,
  MoonIcon,
  NetworkIcon,
  PlayCircleIcon,
  SignOutIcon,
  StackIcon,
  SunIcon,
  BroadcastIcon,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  DropdownMenu,
  Loader,
  Sidebar,
  Surface,
  Text,
} from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { useTheme, type ThemeMode } from "@/lib/theme";

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
    items: [
      { href: "/cluster", label: "主从", icon: NetworkIcon },
      { href: "/status", label: "状态页", icon: BroadcastIcon },
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
  const { theme, setTheme, resolved } = useTheme();

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

  const cycleTheme = () => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const i = order.indexOf(theme);
    setTheme(order[(i + 1) % order.length]);
  };

  return (
    <Sidebar.Provider defaultOpen className="min-h-screen">
      <Sidebar className="flex h-screen flex-col">
        <Sidebar.Header className="!flex !w-full !items-center !justify-between !gap-2">
          <div className="min-w-0 flex-1">
            <Text variant="heading3" as="span">
              Grok Panel
            </Text>
            <Text variant="secondary" size="xs">
              注册 · CPA · 主从
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
          <div className="flex w-full items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={cycleTheme}
              aria-label="切换主题"
            >
              {resolved === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
              <span className="ml-1">{theme}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenu.Trigger aria-label="账号">
                <Button variant="ghost" size="sm">
                  账号
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content side="top" align="end">
                <DropdownMenu.Item
                  onSelect={() => {
                    logout();
                    router.replace("/login/");
                  }}
                >
                  <SignOutIcon size={16} /> 退出
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
          <Badge variant="secondary">kumo</Badge>
        </Sidebar.Footer>
      </Sidebar>

      <main className="min-h-screen flex-1 overflow-auto p-6">{children}</main>
    </Sidebar.Provider>
  );
}
