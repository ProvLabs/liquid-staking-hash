import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/theme/tokens.css";
import "@/theme/global.css";
import { WalletProvider } from "@/tx/wallet";
import { StoreProvider } from "@/data/store";
import { TxProvider } from "@/tx/execute";
import { App } from "@/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletProvider>
      <StoreProvider>
        <TxProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </TxProvider>
      </StoreProvider>
    </WalletProvider>
  </React.StrictMode>,
);
