// App shell + routes (spec §6, §8). DOM order = reading order: nav is authored before
// main for skip-nav, placed left by grid. Seven routes plus role-gated empty states.
import { Routes, Route } from "react-router-dom";
import { TopBar, BannerStack, SideNav, Footer } from "@/components/chrome";
import { Overview } from "@/pages/Overview";
import { Validators } from "@/pages/Validators";
import { EpochOps } from "@/pages/EpochOps";
import { Redemptions } from "@/pages/Redemptions";
import { Desk } from "@/pages/Desk";
import { JailWatch } from "@/pages/JailWatch";
import { Governance } from "@/pages/Governance";
import { Admin } from "@/pages/Admin";

export function App() {
  return (
    <div className="app">
      <TopBar />
      <BannerStack />
      <SideNav />
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/validators" element={<Validators />} />
          <Route path="/epoch" element={<EpochOps />} />
          <Route path="/redemptions" element={<Redemptions />} />
          <Route path="/desk" element={<Desk />} />
          <Route path="/jail" element={<JailWatch />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
