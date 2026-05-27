import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/schedules")({
  component: () => <Outlet />,
});
