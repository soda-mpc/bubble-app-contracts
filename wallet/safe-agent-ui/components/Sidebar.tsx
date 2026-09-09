"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BanknotesIcon,
  BoltIcon,
  BuildingLibraryIcon,
  ClockIcon,
  HomeIcon,
  UserGroupIcon,
  XMarkIcon,
  EyeSlashIcon,
} from "@heroicons/react/24/outline";
import {
  BanknotesIcon as BanknotesIconSolid,
  BoltIcon as BoltIconSolid,
  BuildingLibraryIcon as BuildingLibraryIconSolid,
  ClockIcon as ClockIconSolid,
  HomeIcon as HomeIconSolid,
  UserGroupIcon as UserGroupIconSolid,
  EyeSlashIcon as EyeSlashIconSolid,
} from "@heroicons/react/24/solid";

type SidebarItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  activeIcon: React.ReactNode;
};

const mainItems: SidebarItem[] = [
  {
    label: "Overview",
    href: "/",
    icon: <HomeIcon className="h-6 w-6" />,
    activeIcon: <HomeIconSolid className="h-6 w-6" />,
  },
  {
    label: "Safe",
    href: "/safe",
    icon: <BuildingLibraryIcon className="h-6 w-6" />,
    activeIcon: <BuildingLibraryIconSolid className="h-6 w-6" />,
  },
  {
    label: "Treasury",
    href: "/treasury",
    icon: <BanknotesIcon className="h-6 w-6" />,
    activeIcon: <BanknotesIconSolid className="h-6 w-6" />,
  },
  {
    label: "Agents",
    href: "/agents",
    icon: <UserGroupIcon className="h-6 w-6" />,
    activeIcon: <UserGroupIconSolid className="h-6 w-6" />,
  },
  {
    label: "Notes",
    href: "/notes",
    icon: <EyeSlashIcon className="h-6 w-6" />,
    activeIcon: <EyeSlashIconSolid className="h-6 w-6" />,
  },
  {
    label: "Act as agent",
    href: "/act",
    icon: <BoltIcon className="h-6 w-6" />,
    activeIcon: <BoltIconSolid className="h-6 w-6" />,
  },
  {
    label: "Activity",
    href: "/activity",
    icon: <ClockIcon className="h-6 w-6" />,
    activeIcon: <ClockIconSolid className="h-6 w-6" />,
  },
];

type SidebarProps = {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

function NavSection({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: SidebarItem[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="mb-6 last:mb-0">
      <span className="mb-2 block px-4 text-[10px] font-semibold uppercase tracking-wider text-[var(--wallet-text-muted)]">
        {title}
      </span>
      <ul className="space-y-1">
        {items.map(({ label, href, icon, activeIcon }) => {
          const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));
          return (
            <li key={href}>
              <Link
                href={href}
                prefetch
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-lg border-l-2 border-transparent px-4 py-2.5 transition-colors ${
                  isActive
                    ? "border-[var(--wallet-primary)] bg-[var(--wallet-primary-soft)] text-[var(--wallet-primary)]"
                    : "text-[var(--wallet-text-default)] hover:bg-[var(--wallet-surface-muted)] hover:text-[var(--wallet-text-strong)]"
                }`}
              >
                <span className={isActive ? "text-[var(--wallet-primary)]" : undefined}>
                  {isActive ? activeIcon : icon}
                </span>
                <span className="font-medium">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();

  useEffect(() => {
    onMobileClose?.();
  }, [pathname, onMobileClose]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileOpen]);

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-[var(--wallet-border)] bg-[var(--wallet-surface)] transition-transform duration-300 ease-in-out md:relative md:min-h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--wallet-border)] p-5">
          <Link
            href="/"
            onClick={onMobileClose}
            className="flex min-w-0 items-center gap-3 rounded-lg transition-opacity hover:opacity-90"
          >
            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full bg-transparent">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="SodaLabs logo" src="/logo_soda.png" className="h-full w-full object-cover" />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-bold leading-tight text-[var(--wallet-text-strong)]">Soda</span>
              <span className="text-xs text-[var(--wallet-text-muted)]">Safe agents</span>
            </div>
          </Link>
          <button
            type="button"
            aria-label="Close navigation menu"
            className="rounded-lg p-2 text-[var(--wallet-text-muted)] transition-colors hover:bg-[var(--wallet-surface-muted)] hover:text-[var(--wallet-text-strong)] md:hidden"
            onClick={onMobileClose}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-4">
          <NavSection title="Issuer" items={mainItems} onNavigate={onMobileClose} />
        </nav>
      </aside>
    </>
  );
}
