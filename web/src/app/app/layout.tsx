import type { Metadata } from "next";
import "./workspace.css";

export const metadata: Metadata = {
  title: "Workspace",
  description: "An agent that rents its own compute and pays for it on Hedera.",
};

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <div className="ws-root">{children}</div>;
}
