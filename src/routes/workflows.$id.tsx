import { createFileRoute, Outlet } from "@tanstack/react-router";

// Thin layout. Routing matches /workflows/$id/* to children:
//   - workflows.$id.index.tsx     -> editor
//   - workflows.$id.history.tsx   -> run history
// Without this Outlet, the index component would shadow all siblings.
export const Route = createFileRoute("/workflows/$id")({
  component: () => <Outlet />,
});
