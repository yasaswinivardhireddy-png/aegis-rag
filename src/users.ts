import type { DemoUser } from "./shared.js";

// Demo identities. A production deployment would take identity and role from an identity provider (OIDC).
export const DEMO_USERS: DemoUser[] = [
  { id: "priya", name: "Priya Sharma", title: "Software Engineer", role: "employee" },
  { id: "arjun", name: "Arjun Rao", title: "HR Manager", role: "hr" }
];
