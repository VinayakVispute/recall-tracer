import { redirect } from "next/navigation";

/** The app opens where the coordinator's work starts: the outbreak, then the supplier notice, then the incident. */
export default function Page() {
  redirect("/outbreak");
}
