// The chat page is a client component, so its title comes from this layout.
export const metadata = { title: "Ask the agent" };

export default function Layout({ children }: LayoutProps<"/agent">) {
  return children;
}
