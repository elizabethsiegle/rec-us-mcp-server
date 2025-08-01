import { StytchProvider } from "@stytch/react";
import { StytchUIClient } from "@stytch/vanilla-js";
import { Navigate, Route, BrowserRouter as Router, Routes } from "react-router-dom";
import { Authenticate, Login, Logout } from "./Auth";
import Dashboard from "./Dashboard";

// Initialize Stytch client
const stytch = new StytchUIClient(
  import.meta.env.VITE_STYTCH_PUBLIC_TOKEN ?? ""
  // Remove the domain configuration for now - let Stytch auto-detect
);

// Debug logging
console.log('Stytch Public Token:', import.meta.env.VITE_STYTCH_PUBLIC_TOKEN?.substring(0, 30) + '...');
console.log('Current Origin:', window.location.origin);
console.log('Token type:', import.meta.env.VITE_STYTCH_PUBLIC_TOKEN?.includes('test') ? 'TEST' : 'LIVE');

function App() {
  return (
    <StytchProvider stytch={stytch}>
      <main style={{ maxWidth: "800px", margin: "0 auto", padding: "20px" }}>
        <h1>🎾 Tennis Court MCP Authentication</h1>
        <Router>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/authenticate" element={<Authenticate />} />
            <Route path="/dashboard" element={<Dashboard />} />
            {/* Only redirect to dashboard if we're at root, not other paths */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Router>
      </main>
      <footer style={{ marginTop: "40px", textAlign: "center" }}>
        <Logout />
      </footer>
    </StytchProvider>
  );
}

export default App;