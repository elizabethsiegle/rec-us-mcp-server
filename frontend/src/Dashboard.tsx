import { useStytchUser } from "@stytch/react";
import { withLoginRequired } from "./Auth";

function Dashboard() {
  const { user } = useStytchUser();
  
  return (
    <div style={{ maxWidth: "600px", margin: "0 auto" }}>
      <h2>Welcome, {user?.emails?.[0]?.email || 'User'}!</h2>
      
      <div style={{ 
        background: "#f5f5f5", 
        padding: "20px", 
        borderRadius: "8px", 
        marginTop: "20px" 
      }}>
        <h3>✅ Authentication Successful</h3>
        <p>Your session has been stored and you can now use the MCP tools in Claude Desktop.</p>
        
        <h4>Available MCP Tools:</h4>
        <ul>
          <li><code>check_tennis_courts</code> - Check court availability</li>
          <li><code>book_and_request_sms</code> - Book a tennis court</li>
          <li><code>enter_sms_code_and_complete</code> - Complete booking with SMS code</li>
          <li><code>get_booking_history</code> - View your booking history</li>
          <li><code>auth_status</code> - Check authentication status</li>
        </ul>
        
        <h4>Session Info:</h4>
        <ul>
          <li>Email: {user?.emails?.[0]?.email}</li>
          <li>User ID: {user?.user_id}</li>
          <li>Session Duration: 24 hours</li>
        </ul>
        
        <div style={{ 
          marginTop: "20px", 
          padding: "15px", 
          background: "#fff3cd", 
          border: "1px solid #ffeeba",
          borderRadius: "5px" 
        }}>
          <p><strong>⚠️ Important:</strong> Authentication is now active for 24 hours</p>
          <p>If MCP tools show "not authenticated", wait a few seconds for the session to sync, then try again.</p>
        </div>
      </div>
    </div>
  );
}

// Wrap with login requirement
export default withLoginRequired(Dashboard);