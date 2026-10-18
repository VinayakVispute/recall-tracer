// The chat page is a client component, so its title comes from this layout.
export const metadata = { title: "Ask the agent", description: "Ask the recall agent about any lot or store. It answers from FalkorDB graph queries and shows the evidence behind each answer." };

export default function Layout({ children }: LayoutProps<"/agent">) {
  return children;
}
