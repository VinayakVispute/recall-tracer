import { redirect } from "next/navigation";

/** The Incident tab decides: the incident under review, or how to open one. */
export default function Page() {
  redirect("/incident");
}
