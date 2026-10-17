"use client";

import dynamic from "next/dynamic";
import Loading from "./loading";

// The dashboard shows times in the coordinator's timezone and a live clock, so it renders in the browser only
// (a UTC server would never match). Its data still comes from the server page, already in the payload.
export const IncidentClient = dynamic(() => import("./incident-view").then((m) => m.IncidentView), { ssr: false, loading: Loading });
