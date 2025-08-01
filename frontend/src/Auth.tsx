import { StytchLogin, useStytch, useStytchUser } from "@stytch/react";
import {
  OAuthProviders,
  Products,
  type StytchLoginConfig,
} from "@stytch/vanilla-js";
import { useEffect, useMemo } from "react";

/**
 * A higher-order component that enforces a login requirement for the wrapped component.
 * If the user is not logged in, the user is redirected to the login page and the
 * current URL is stored in localStorage to enable return after authentication.
 */
export const withLoginRequired = (Component: React.FC) => () => {
  const { user, fromCache } = useStytchUser();
  
  console.log('withLoginRequired check:', { user, fromCache });
  
  useEffect(() => {
    // Don't redirect if we're still loading user from cache
    if (fromCache) {
      console.log('Still loading user from cache...');
      return;
    }
    
    if (!user) {
      console.log('No user found, redirecting to login');
      localStorage.setItem("returnTo", window.location.href);
      window.location.href = "/login";
    }
  }, [user, fromCache]);
  
  // Show loading while checking cache
  if (fromCache) {
    return <div>Loading...</div>;
  }
  
  if (!user) {
    return null;
  }
  
  return <Component />;
};

/**
 * The other half of the withLoginRequired flow
 * Redirects the user to a specified URL stored in local storage or a default location.
 */
const onLoginComplete = async () => {
  console.log('onLoginComplete called');
  
  const returnTo = localStorage.getItem("returnTo");
  console.log('Return to URL:', returnTo);
  
  if (returnTo && returnTo !== "") {
    localStorage.removeItem("returnTo");
    console.log('Redirecting to saved URL:', returnTo);
    window.location.href = returnTo;
  } else {
    console.log('Redirecting to dashboard');
    window.location.href = "/dashboard";
  }
};

/**
 * The Login page implementation. Wraps the StytchLogin UI component.
 */
export function Login() {
  const loginConfig = useMemo<StytchLoginConfig>(
    () => ({
      oauthOptions: {
        loginRedirectURL: `${window.location.origin}/authenticate`,
        providers: [{ type: OAuthProviders.Google }],
        signupRedirectURL: `${window.location.origin}/authenticate`,
      },
      products: [Products.oauth],
    }),
    [],
  );
  
  // Debug: Log the redirect URLs
  console.log('OAuth Redirect URLs:', {
    login: `${window.location.origin}/authenticate`,
    signup: `${window.location.origin}/authenticate`,
  });
  
  return (
    <div style={{ maxWidth: "400px", margin: "0 auto" }}>
      <StytchLogin config={loginConfig} />
    </div>
  );
}

/**
 * The Authentication callback page implementation. Handles completing the login flow after OAuth
 */
export function Authenticate() {
  const client = useStytch();
  
  useEffect(() => {
    console.log('Authenticate component mounted');
    console.log('Current URL:', window.location.href);
    
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    
    console.log('Token from URL:', token);
    
    if (!token) {
      console.error('No token in URL params');
      return;
    }
    
    console.log('Attempting to authenticate with token...');
    
    client.oauth
      .authenticate(token, { session_duration_minutes: 60 }) // 1 hour
      .then(async (response) => {
        console.log('OAuth authenticate response:', response);
        
        // Store session info locally
        localStorage.setItem("stytch_session", response.session_token);
        localStorage.setItem("stytch_user_id", response.user.user_id);
        
        try {
          const workerUrl = import.meta.env.VITE_WORKER_URL || "https://rec-us-mcp-server-auth.lizziepika.workers.dev";
          
          // 🔧 NEW: Send user info directly instead of token
          const userInfo = {
            userId: response.user.user_id,
            email: response.user.emails[0]?.email,
            verified: true,
            sessionToken: response.session_token
          };
          
          console.log('Notifying worker at:', `${workerUrl}/authenticate`);
          console.log('Sending user info:', userInfo);
          
          const workerResponse = await fetch(`${workerUrl}/authenticate`, {
            method: 'POST', // Changed to POST
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/plain',
            },
            body: JSON.stringify(userInfo) // Send user info instead of token
          });
          
          if (!workerResponse.ok) {
            const errorText = await workerResponse.text();
            console.error('Worker notification failed:', errorText);
            alert(`Worker authentication failed: ${errorText}`);
          } else {
            const successText = await workerResponse.text();
            console.log('Worker notified successfully:', successText);
          }
        } catch (error) {
          console.error('Failed to notify worker:', error);
          alert(`Failed to sync with MCP server: ${error}`);
          // Continue anyway - the session is stored locally
        }
        
        console.log('Authentication successful, redirecting...');
        onLoginComplete();
      })
      .catch((error) => {
        console.error("Authentication failed:", error);
        alert(`Authentication failed: ${error.message}`);
        window.location.href = "/login";
      });
  }, [client]);
  
  return (
    <div style={{ padding: "20px", textAlign: "center" }}>
      <h3>🔐 Authenticating...</h3>
      <p>Processing your authentication and syncing with MCP server...</p>
      <p><small>Check console for debug info</small></p>
    </div>
  );
}

/**
 * Logout button component
 */
export const Logout = () => {
  const stytch = useStytch();
  const { user } = useStytchUser();
  
  if (!user) return null;
  
  const handleLogout = async () => {
    try {
      await stytch.session.revoke();
      localStorage.removeItem("stytch_session");
      window.location.href = "/login";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };
  
  return (
    <button type="button" onClick={handleLogout}>
      Log Out
    </button>
  );
};