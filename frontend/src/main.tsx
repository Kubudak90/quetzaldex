import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClientProvider } from "./sdk/client-context.js";
import { L1Provider } from "./l1/provider.js";
import App from "./App.js";

declare global {
  interface Window {
    lucide?: { createIcons: () => void };
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reads against a private L2 are expensive; cache aggressively + manual refetch
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <L1Provider>
      <QueryClientProvider client={queryClient}>
        <ClientProvider>
          <App />
        </ClientProvider>
      </QueryClientProvider>
    </L1Provider>
  </React.StrictMode>,
);
