import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { launch, type BrowserWorker } from "@cloudflare/playwright";
import { env } from 'cloudflare:workers'

interface Env {
	AI: any;                         
	MYBROWSER: BrowserWorker;         
	MCP: DurableObjectNamespace;      
	KV: KVNamespace;           
	REC_EMAIL: string;                
	REC_PASSWORD: string;             
	AUTHORIZED_USER_EMAILS: string; // google emails that can book a court
}

// auth utilities
interface AuthenticatedUser {
	id: string;
	email: string;
	verified: boolean;
}

// helper func to get env variables w/ proper types
function getEnv<Env>() {
	return env as Env;
}

// helper func to store MCP session
async function storeMCPSession(env: Env, userId: string, email: string): Promise<void> {
	const sessionKey = `mcp_session:${userId}`;
	const sessionData = JSON.stringify({
		id: userId,
		email: email,
		verified: true,
		timestamp: Date.now()
	});
	
	await env.KV.put(sessionKey, sessionData, {
		expirationTtl: 3600 // 1 hour in seconds
	});
}

export class MyMCP extends McpAgent {
	server: McpServer;

	// pages auth url
	private readonly AUTH_URL = "https://mcp-tennis-auth.pages.dev/login";

	// browser management props
	private browser: any = null;                          
	private lastBrowserInit: number = 0;                  
	private readonly BROWSER_TIMEOUT = 5 * 60 * 1000;    
	private initPromise: Promise<void> | null = null;     
	private isInitializing = false;                       

	// registration guard
	private toolsRegistered = false;

	// helper func to store pending booking details
	private async storePendingBooking(userId: string, court: string, time: string, date: string): Promise<void> {
		try {
			const pendingBookingData = {
				court: court,
				time: time,
				date: date,
				timestamp: Date.now()
			};
			
			const pendingKey = `pending_booking:${userId}`;
			await (env as any).KV.put(pendingKey, JSON.stringify(pendingBookingData), {
				expirationTtl: 3600 // 1 hour in seconds
			});
			
			console.log(`✅ Pending booking stored: ${pendingKey}`);
		} catch (error) {
			console.error('❌ Error storing pending booking:', error);
		}
	}

	// helper func to get pending booking details
	private async getPendingBooking(userId: string): Promise<{court: string, time: string, date: string} | null> {
		try {
			const pendingKey = `pending_booking:${userId}`;
			const pendingData = await (env as any).KV.get(pendingKey);
			
			if (pendingData) {
				const bookingData = JSON.parse(pendingData);
				// Check if pending booking is < 1 hour old
				if (Date.now() - bookingData.timestamp < 3600000) {
					return bookingData;
				}
			}
			
			return null;
		} catch (error) {
			console.error('❌ Error getting pending booking:', error);
			return null;
		}
	}

	// helper func to clear pending booking
	private async clearPendingBooking(userId: string): Promise<void> {
		try {
			const pendingKey = `pending_booking:${userId}`;
			await (env as any).KV.delete(pendingKey);
			console.log(`✅ Pending booking cleared: ${pendingKey}`);
		} catch (error) {
			console.error('❌ Error clearing pending booking:', error);
		}
	}

	constructor(state: any) {
		// init MCP server with metadata
		const server = new McpServer({
			name: "Tennis Court Booking (Consumer Auth)",
			version: "5.0.0",
		});
		super(state, { server });
		this.server = server;
		
		// Only register tools if not already registered
		if (!this.toolsRegistered) {
			this.initializeTools(); // Register all available tools
			this.toolsRegistered = true;
		}
	}

	// auth error msg helper
	private getAuthRequiredMessage(currentEnv: Env): string {
		return `Auth required

		This booking operation requires authentication.

		**Authenticate now:**
		Visit: ${this.AUTH_URL}

		Steps:
		1. Click or visit the auth URL above
		2. Sign in with Google using an authorized email
		3. Return here and try the booking again

		Authorized users: ${currentEnv.AUTHORIZED_USER_EMAILS || 'No authorized users configured'}

		The auth page will handle the OAuth flow and register your session automatically.`;
	}
	private async authenticateUser(extra?: any): Promise<AuthenticatedUser | null> {
		try {
			// For MCP clients, check if we have a stored session
			const mcpSession = await this.getMCPSession();
			if (mcpSession) {
				return mcpSession;
			}

			console.log('🔐 No valid authentication found');
			return null;
		} catch (error) {
			console.error('Authentication error:', error);
			return null;
		}
	}

	// Get MCP session
	private async getMCPSession(): Promise<AuthenticatedUser | null> {
		const currentEnv = getEnv() as Env;
		
		// Look for any recent auth session
		const keys = await currentEnv.KV.list({ prefix: 'mcp_session:' });
		for (const key of keys.keys) {
			const session = await currentEnv.KV.get(key.name);
			if (session) {
				const sessionData = JSON.parse(session);
				// Check if session is < 1 hour old
				if (Date.now() - sessionData.timestamp < 3600000) {
					return sessionData;
				}
			}
		}
		
		return null;
	}

	// browser init/management
	async init() {
		if (this.isInitializing) {
			await this.initPromise;
			return;
		}

		const now = Date.now();
		if (this.browser && (now - this.lastBrowserInit) < this.BROWSER_TIMEOUT) {
			return;
		}

		this.isInitializing = true;
		this.initPromise = (async () => {
			try {
				if (this.browser) {
					await this.browser.close();
					this.browser = null;
				}

				console.log('Attempting to launch browser...');
				console.log('MYBROWSER binding exists:', !!(env as any).MYBROWSER);
				
				if (!(env as any).MYBROWSER) {
					throw new Error('MYBROWSER binding not found in environment. Check wrangler.toml has [[browser]] binding = "MYBROWSER"');
				}

				this.browser = await launch((env as any).MYBROWSER);
				this.lastBrowserInit = now;
				console.log('Browser launched successfully');
			} catch (error: unknown) {
				console.error('Browser initialization failed:', error);
				this.browser = null;
				throw error;
			} finally {
				this.isInitializing = false;
				this.initPromise = null;
			}
		})();

		await this.initPromise;
	}

	async cleanup() {
		if (this.browser) {
			try {
				await this.browser.close();
				this.browser = null;
				this.lastBrowserInit = 0;
			} catch (error) {
				console.error('Error during browser cleanup:', error);
			}
		}
	}

	// utility funcs
	private log(str: string, email: string = 'system') {
		const date = new Date();
		console.log(`${email}:${date.getMonth() + 1}/${date.getDate()},${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} - ${str}`);
	}

	private getCorrectDate(dateInput?: string): string {
		const today = new Date();
		today.setFullYear(2025);
		
		if (!dateInput) {
			const tomorrow = new Date(today);
			tomorrow.setDate(today.getDate() + 1);
			return tomorrow.toISOString().split('T')[0];
		}
		
		if (dateInput.toLowerCase() === 'today') {
			return today.toISOString().split('T')[0];
		}
		
		if (dateInput.toLowerCase() === 'tomorrow') {
			const tomorrow = new Date(today);
			tomorrow.setDate(today.getDate() + 1);
			return tomorrow.toISOString().split('T')[0];
		}
		
		const providedDate = new Date(dateInput);
		if (providedDate.getFullYear() < 2025) {
			providedDate.setFullYear(2025);
		}
		
		return providedDate.toISOString().split('T')[0];
	}

	private async saveBookingToKV(court: string, time: string, date: string, userEmail: string): Promise<void> {
		try {
			const bookingData = {
				court: court,
				time: time,
				date: date,
				userEmail: userEmail,
				timestamp: Date.now(),
				status: 'completed'
			};
			
			// Save with date as key for easy retrieval
			const dateKey = `booking:${date}`;
			await (env as any).KV.put(dateKey, JSON.stringify(bookingData));
			
			console.log(`✅ Booking saved to KV: ${dateKey}`);
		} catch (error) {
			console.error('❌ Error saving booking to KV:', error);
		}
	}

	// MCP tools
	private initializeTools() {
		// Prevent double registration
		if (this.toolsRegistered) {
			console.log('Tools already registered, skipping...');
			return;
		}

		console.log('Registering MCP tools...');
		
		// Tool 1: Check tennis court availability no auth
		this.server.tool(
			"check_tennis_courts",
			{
				date: z.string().optional().describe("Date in YYYY-MM-DD format, 'today', 'tomorrow', or leave empty for tomorrow"),
				court: z.string().optional().describe("Specific court name (DuPont, McLaren, Alice Marble, etc.)"),
				time: z.string().optional().describe("Preferred time (e.g., '8:00 AM')"),
			},
			async ({ date, court, time }) => {
				const correctedDate = this.getCorrectDate(date);
				
				try {
					console.log('Starting check_tennis_courts...');
					await this.init(); // Ensure browser is ready
					
					if (!this.browser) {
						return {
							content: [{
								type: "text",
								text: "Error: Browser initialization failed. Check that MYBROWSER binding is configured in wrangler.toml:\n\n[[browser]]\nbinding = \"MYBROWSER\""
							}]
						};
					}
		
					console.log('Browser available, creating page...');
					const page = await this.browser.newPage();
		
					this.log('Checking court availability');
					await page.goto("https://www.rec.us/sfrecpark");
		
					// Use the requested court or default to DuPont
					const targetCourt = court || 'DuPont';
					let availability = null;
		
					try {
						// Navigate to the specific court page
						await page.getByText(targetCourt).click();
						await page.waitForSelector('text=Court Reservations', { timeout: 5000 });
		
						// Handle date navigation
						const targetDate = new Date(correctedDate);
						const today = new Date();
						today.setFullYear(2025);
						const nextMonth = targetDate.getMonth() !== today.getMonth();
		
						// Open date picker
						await page.locator('input').click();
						
						// Navigate to next month if needed
						if (nextMonth) {
							await page.getByRole('button', { name: 'right' }).click();
						}
		
						// Select specific day (with zero padding for single digits)
						const day = targetDate.getDate();
						await page.locator(`.react-datepicker__day--0${day < 10 ? '0' : ''}${day}:not(.react-datepicker__day--outside-month)`).first().click();
		
						// Wait for available times to load
						await page.waitForSelector('text=/(\\d:)|(No free)/', { timeout: 5000 });
		
						// Extract available time slots from the page
						const times = await page.getByText('Tennis').first().evaluate((el: HTMLElement) => (el.parentElement as HTMLElement).innerText);
						const availableTimes = times.split('\n').filter((slot: string) => slot.includes(':'));
		
						// Compile availability data
						availability = {
							court: targetCourt,
							date: correctedDate,
							availableTimes: availableTimes,
							requestedTimeAvailable: time ? availableTimes.some((slot: string) => slot.includes(time)) : null,
							totalSlots: availableTimes.length
						};
		
					} catch (error) {
						this.log(`Error checking ${targetCourt}: ${error}`);
						availability = {
							court: targetCourt,
							date: correctedDate,
							error: error instanceof Error ? error.message : 'Unknown error',
							availableTimes: [],
							totalSlots: 0
						};
					}
		
					await page.close(); // Clean up the page
		
					// Workers AI generates natural language resp
					let responseText;
					try {
						const messages = [
							{ 
								role: "system", 
								content: "You are a helpful tennis court booking assistant. Convert tennis court availability data into a friendly, conversational response. Be concise but informative." 
							},
							{
								role: "user",
								content: `Please summarize this tennis court availability data in a natural, friendly way:
								
								Court: ${availability.court}
								Date: ${correctedDate}
								Available times: ${availability.availableTimes.length > 0 ? availability.availableTimes.join(', ') : 'None available'}
								Requested time: ${time || 'None specified'}
								Requested time available: ${availability.requestedTimeAvailable}
								
								${availability.error ? `Error occurred: ${availability.error}` : ''}
								
								Make it conversational and helpful.`
							},
						];
		
						const aiResponse = await (getEnv() as any).AI.run("@cf/meta/llama-3.1-8b-instruct", { messages });
						responseText = aiResponse.response || "I was able to check the court availability, but had trouble generating a summary.";
		
					} catch (aiError) {
						console.error('AI response generation failed:', aiError);
						// Fallback to manual response generation
						if (availability.error) {
							responseText = `Sorry, I couldn't check availability for ${targetCourt} on ${correctedDate}. Error: ${availability.error}`;
						} else if (availability.totalSlots === 0) {
							responseText = `No time slots are available at ${targetCourt} on ${correctedDate}.`;
						} else {
							responseText = `${targetCourt} has ${availability.totalSlots} available time slots on ${correctedDate}: ${availability.availableTimes.join(', ')}.${time && availability.requestedTimeAvailable ? ` Your requested time of ${time} is available!` : time && !availability.requestedTimeAvailable ? ` Unfortunately, your requested time of ${time} is not available.` : ''}`;
						}
					}
		
					return {
						content: [{
							type: "text",
							text: responseText
						}]
					};
		
				} catch (error) {
					console.error('Error checking court availability:', error);
					return {
						content: [{
							type: "text",
							text: `I encountered an error while checking court availability: ${error instanceof Error ? error.message : 'Unknown error'}`
						}]
					};
				}
			}
		);

		// Tool 2: Book court and request SMS. Protected/auth required
		this.server.tool(
			"book_and_request_sms",
			{
				court: z.string().describe("Court name"),
				time: z.string().describe("Time slot"),
				date: z.string().describe("Date in YYYY-MM-DD format")
			},
			async ({ court, time, date }, extra) => {
				// auth check!
				const user = await this.authenticateUser(extra);
				if (!user) {
					const currentEnv = getEnv() as Env;
					return {
						content: [{
							type: "text",
							text: this.getAuthRequiredMessage(currentEnv)
						}]
					};
				}

				console.log(`✅ Authenticated user ${user.email} is booking court...`);
				
				console.log('Starting booking and requesting SMS...');
				
				if (!this.browser) {
					await this.init();
				}
				
				const recEmail = (env as any).REC_EMAIL;
				const recPassword = (env as any).REC_PASSWORD;
				
				let page;
				try {
					page = await this.browser.newPage();
					page.setDefaultTimeout(12000);
					
					console.log('1. Connecting...');
					await page.goto("https://www.rec.us/sfrecpark", { 
						timeout: 20000,
						waitUntil: 'domcontentloaded'
					});
					await page.waitForTimeout(2000);
					
					console.log('2. Logging in...');
					await page.waitForSelector('text=Log In', { timeout: 10000 });
					await page.getByText('Log In').click();
					await page.waitForSelector('input[id="email"]', { timeout: 8000 });
					await page.fill('input[id="email"]', recEmail);
					await page.fill('input[id="password"]', recPassword);
					await page.getByText('log in & continue').click();
					await page.waitForTimeout(3000);
					
					console.log('3. Going to court...');
					await page.waitForSelector(`text=${court}`, { timeout: 10000 });
					await page.getByText(court).click();
					await page.waitForTimeout(2000);
					
					console.log('4. Selecting date...');
					const bookDate = new Date(date);
					const today = new Date();
					today.setFullYear(2025);
					const targetDay = bookDate.getDate();
					const nextMonth = bookDate.getMonth() !== today.getMonth();

					console.log('Clicking date input...');
					await page.locator('input').click();
					
					await page.waitForSelector('.react-datepicker', { timeout: 5000 });
					await page.waitForTimeout(1000);
					
					if (nextMonth) {
						console.log('Going to next month...');
						await page.getByRole('button', { name: 'right' }).click();
						await page.waitForTimeout(500);
					}
					
					console.log(`Selecting day ${targetDay}...`);
					const daySelector = `.react-datepicker__day--0${targetDay < 10 ? '0' : ''}${targetDay}:not(.react-datepicker__day--outside-month)`;
					await page.locator(daySelector).first().click();
					await page.waitForTimeout(1500);
					
					console.log('5. Checking time availability...');
					await page.waitForSelector('text=/(\\d:)|(No free)/', { timeout: 8000 });
					const times = await page.getByText('Tennis').first().evaluate((el: HTMLElement) => (el.parentElement as HTMLElement).innerText);
					
					let normalizedTime = time;
					if (time.toLowerCase().includes('pm') || time.toLowerCase().includes('am')) {
						if (!time.includes(':')) {
							normalizedTime = time.replace(/(\d+)(pm|am)/i, '$1:00 $2').toUpperCase();
						}
					}
					
					console.log(`Looking for time: ${normalizedTime} in available times: ${times.replace(/\n/g, ', ')}`);
					
					if (!times.includes(normalizedTime)) {
						throw new Error(`${normalizedTime} not available. Available: ${times.replace(/\n/g, ', ')}`);
					}
					
					console.log('6. Booking time...');
					await page.getByText(normalizedTime).click();
					
					console.log('7. Setting duration...');
					await page.locator(`xpath=//label[text()='Duration']/following-sibling::button`).click();
					await page.waitForSelector('text=2 hours', { timeout: 5000 });
					await page.locator('div[role="option"]:not([aria-disabled="true"])').first().click();
					
					console.log('8. Selecting participant...');
					await page.getByText('Select participant').click();
					await page.getByText('Account Owner').click();
					
					console.log('9. Requesting SMS...');
					await page.locator('button.max-w-max').click();
					await page.getByText('Send Code').click();
					
					await page.waitForTimeout(2000);
					
					await page.waitForSelector('input[id="totp"]', { timeout: 8000 });
					console.log('✅ SMS verification step reached!');
					
					// Store pending booking details for later retrieval
					await this.storePendingBooking(user.id, court, normalizedTime, date);
					
					return {
						content: [{
							type: "text",
							text: `SMS code requested! 

							- Authenticated as: ${user.email}
							- Court: ${court}
							- Time: ${normalizedTime}
							- Date: ${date}

							An SMS verification code has been sent to your phone.

							When you receive the SMS code, run:
							enter_sms_code_and_complete({"code": "YOUR_SMS_CODE"})

							🔥 Browser is waiting at verification step!`
						}]
					};
					
				} catch (error) {
					if (page) await page.close();
					return {
						content: [{
							type: "text",
							text: `❌ Booking failed: ${error instanceof Error ? error.message : 'Unknown error'}`
						}]
					};
				}
			}
		);

		this.server.tool(
			"enter_sms_code_and_complete",
			{
				code: z.string().describe("SMS verification code you received on your phone")
			},
			async ({ code }, extra) => {
				// auth check
				const user = await this.authenticateUser(extra);
				if (!user) {
					const currentEnv = getEnv() as Env;
					return {
						content: [{
							type: "text",
							text: this.getAuthRequiredMessage(currentEnv)
						}]
					};
				}
		
				console.log(`✅ Authenticated user ${user.email} is completing booking with SMS code: ${code}`);
				
				if (!this.browser) {
					await this.init();
				}
				
				try {
					// Find page w/ SMS verification input
					const pages = await this.browser.contexts()[0]?.pages() || [];
					let verificationPage = null;
					
					for (const page of pages) {
						try {
							// Look for the exact input element specified
							const hasTotp = await page.locator('input[id="totp"]').isVisible({ timeout: 1000 }).catch(() => false);
							if (hasTotp) {
								verificationPage = page;
								console.log('Found verification page with SMS input');
								break;
							}
						} catch (e) {
							continue;
						}
					}
					
					if (!verificationPage) {
						return {
							content: [{
								type: "text",
								text: `❌ No SMS verification page found.
		
								Please:
								1. Complete your booking manually until you reach SMS verification step
								2. Click "Send Code" button  
								3. When you get the SMS, run this tool again
								
								The verification page should have an input field for the code.`
							}]
						};
					}
					
					console.log('Found SMS verification input, entering code...');
					
					// use page.type instead of fill
					console.log('entering code');
					await verificationPage.type('input[id="totp"]', code);
					
					// timeout pattern
					verificationPage.setDefaultTimeout(180000); // 3 minute timeout like GitHub
					console.log('confirming with 3 min timeout');
					
					// confirm click pattern
					try {
						await verificationPage.getByText('Confirm').last().click();
					} catch (e) {
						// keep trying
						console.log("couldn't click confirm somehow");
						throw new Error(e as string);
					}
					
					// success detection pattern
					try {
						await verificationPage.waitForSelector("text=You're all set!");
						console.log('success!, terminating');
						
						// Retrieve pending booking details
						const pendingBooking = await this.getPendingBooking(user.id);
						if (!pendingBooking) {
							return {
								content: [{
									type: "text",
									text: `❌ No pending booking found for user ${user.email}. Cannot complete booking.`
								}]
							};
						}

						const { court, time, date } = pendingBooking;
						await this.clearPendingBooking(user.id); // Clear pending booking after successful completion

						await this.saveBookingToKV(court, time, date, user.email);
						
						return {
							content: [{
								type: "text",
								text: `🎾 BOOKING COMPLETED!
		
								- Completed by: ${user.email}
								- SMS code ${code} accepted
								- "You're all set!" confirmation received
								- Your tennis court is booked!`
							}]
						};
						
					} catch (e) {
						console.error(e);
						console.log('script was too late to book :(, terminating');
						
						// Check for specific error like GitHub code
						try {
							const pageText = await verificationPage.textContent('body', { timeout: 3000 }).catch(() => '');
							if (pageText.includes('Court already reserved at this time')) {
								return {
									content: [{
										type: "text",
										text: `❌ Court already reserved at this time`
									}]
								};
							}
						} catch (ee) {
							// Ignore
						}
						
						return {
							content: [{
								type: "text",
								text: `❌ Booking timeout - check SF Rec website manually to verify booking status`
							}]
						};
					}
					
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
						}]
					};
				}
			}
		);

		// Tool 4--public browser diagnostic
		this.server.tool(
			"test_browser",
			{},
			async () => {
				try {
					console.log('Testing browser configuration...');
					console.log('MYBROWSER binding exists:', !!(env as any).MYBROWSER);
					console.log('Environment keys:', Object.keys(env || {}));
					
					const browser = await launch((env as any).MYBROWSER);
					const page = await browser.newPage();
					await page.goto("https://example.com");
					const title = await page.title();
					await browser.close();
					
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: true,
								message: "Browser is working correctly!",
								testPageTitle: title,
								binding: "MYBROWSER found and functional"
							}, null, 2)
						}]
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : 'Unknown error',
								debugging: {
									mybrowserExists: !!(env as any).MYBROWSER,
									envKeys: Object.keys(env || {}),
									errorType: error instanceof Error ? error.constructor.name : 'Unknown'
								},
								fix: "Add [[browser]] binding = \"MYBROWSER\" to wrangler.toml"
							}, null, 2)
						}]
					};
				}
			}
		);

		// Tool 5:booking history. auth required
		this.server.tool(
			"get_booking_history",
			{
				days: z.number().optional().describe("Number of days to look back (default 30)")
			},
			async ({ days = 30 }, extra) => {
				// 🔒 AUTH CHECK
				const user = await this.authenticateUser(extra);
				if (!user) {
					const currentEnv = getEnv() as Env;
					return {
						content: [{
							type: "text",
							text: this.getAuthRequiredMessage(currentEnv)
						}]
					};
				}

				try {
					const bookings = [];
					const today = new Date();
					
					// Search for bookings in the last N days using YYYY-MM-DD format
					for (let i = 0; i < days; i++) {
						const checkDate = new Date();
						checkDate.setDate(today.getDate() - i);
						const dateStr = checkDate.toISOString().split('T')[0]; // YYYY-MM-DD format
						
						const bookingData = await (env as any).KV.get(`booking:${dateStr}`);
						
						if (bookingData) {
							try {
								const booking = JSON.parse(bookingData);
								// Only show bookings for the authenticated user
								if (booking.userEmail === user.email) {
									bookings.push({
										date: dateStr,
										court: booking.court,
										time: booking.time,
										status: booking.status,
										bookedAt: new Date(booking.timestamp).toLocaleString()
									});
								}
							} catch (parseError) {
								console.error('Error parsing booking data:', parseError);
							}
						}
					}

					return {
						content: [{
							type: "text",
							text: `📋 Booking History for ${user.email}

							Found ${bookings.length} bookings in the last ${days} days:

							${bookings.length > 0 ? 
								bookings.map(b => `📅 ${b.date} - 🏟️ ${b.court} at ⏰ ${b.time} (${b.status})`).join('\n') : 
								'No bookings found in this time period.'
							}

							${bookings.length > 0 ? `\n🔍 Detailed data:\n${JSON.stringify(bookings, null, 2)}` : ''}`
						}]
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `Error getting booking history: ${error instanceof Error ? error.message : 'Unknown error'}`
						}]
					};
				}
			}
		);

		// Tool 6: get auth url (public)
		this.server.tool(
			"get_auth_url",
			{},
			async () => {
				const currentEnv = getEnv() as Env;
				return {
					content: [{
						type: "text",
						text: `🔗 AUTHENTICATION URL

						Visit this link to authenticate via Google OAuth: ${this.AUTH_URL}

						This will:
						1. Redirect you to Google OAuth
						2. Verify you're an authorized user
						3. Register your session with the MCP server
						4. Allow you to use protected booking tools

						Authorized users: ${currentEnv.AUTHORIZED_USER_EMAILS || 'none configured'}

						After authentication, return here and try booking again.`
					}]
				};
			}
		);

		// public tool: auth status
		this.server.tool(
			"auth_status",
			{},
			async (params, extra) => {
				try {
					const user = await this.authenticateUser(extra);
					if (user) {
						return {
							content: [{
								type: "text",
								text: `✅ AUTHENTICATED

								User: ${user.email}
								ID: ${user.id}
								Email Verified: ${user.verified}

								You can now use:
								- book_and_request_sms (book courts)
								- enter_sms_code_and_complete (complete bookings)
								- get_booking_history (view your bookings)

								Anyone can still use:
								- check_tennis_courts (check court availability)
								- test_browser (diagnostic tool)
								- get_auth_url (get auth link)`
							}]
						};
					} else {
						const currentEnv = getEnv() as Env;
						return {
							content: [{
								type: "text",
								text: `🔐 !AUTHENTICATED

								🔗 **AUTHENTICATE NOW:**
								Visit: ${this.AUTH_URL}

								Available without auth:
								- check_tennis_courts (check court availability)
								- test_browser (diagnostic tool)
								- get_auth_url (get auth link)

								Requires auth:
								- book_and_request_sms
								- enter_sms_code_and_complete  
								- get_booking_history

								Authorized users: ${currentEnv.AUTHORIZED_USER_EMAILS || 'none configured'}`
							}]
						};
					}
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `❌ Auth status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
						}]
					};
				}
			}
		);

		console.log('✅ All tools registered successfully');
	}
}

// Worker
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		// auth endpoint
		if (url.pathname === '/authenticate') {
			// Add CORS headers to all responses
			const corsHeaders = {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
			};
			
			if (request.method === 'POST') {
				try {
					// Get user info from frontend (already authenticated with Stytch)
					const userInfo = await request.json() as any;
					
					console.log('Received user info from frontend:', userInfo);
					
					// Check if user is authorized
					const authorizedEmails = env.AUTHORIZED_USER_EMAILS
						.split(',')
						.map(email => email.trim().toLowerCase());
					
					if (!authorizedEmails.includes(userInfo.email.toLowerCase())) {
						console.log(`Unauthorized user: ${userInfo.email}`);
						return new Response(`Unauthorized user: ${userInfo.email}`, { 
							status: 403,
							headers: corsHeaders
						});
					}
					
					// Store session for MCP access (no Stytch API call needed!)
					console.log('Storing session for user:', userInfo.email);
					await storeMCPSession(env, userInfo.userId, userInfo.email);
					
					// Return success
					return new Response('Authentication successful', { 
						status: 200,
						headers: {
							...corsHeaders,
							'Content-Type': 'text/plain'
						}
					});
					
				} catch (error) {
					console.error('Authentication error:', error);
					return new Response(`Authentication error: ${error}`, { 
						status: 500,
						headers: corsHeaders
					});
				}
			}
			
			return new Response('Method not allowed', { 
				status: 405,
				headers: corsHeaders
			});
		}

		// Debug endpoint to check stored sessions
		if (url.pathname === '/debug-sessions') {
			try {
				const keys = await env.KV.list({ prefix: 'mcp_session:' });
				const sessions = [];
				
				for (const key of keys.keys) {
					const session = await env.KV.get(key.name);
					if (session) {
						const data = JSON.parse(session);
						sessions.push({
							key: key.name,
							email: data.email,
							timestamp: new Date(data.timestamp).toISOString()
						});
					}
				}
				
				return new Response(JSON.stringify({
					totalSessions: sessions.length,
					sessions: sessions
				}, null, 2), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				return new Response(`Error: ${error}`, { status: 500 });
			}
		}

		// Root endpoint with info
		if (url.pathname === '/') {
			return new Response(`🎾 SF Tennis Court Booking MCP Server

			This server uses simplified frontend authentication.

			Public endpoints:
			- check_tennis_courts (check court availability)
			- test_browser (diagnostic tool)
			- auth_status (check authentication status)
			- get_auth_url (get authentication URL)

			Protected endpoints (auth required):
			- book_and_request_sms (book courts)
			- enter_sms_code_and_complete (complete bookings)  
			- get_booking_history (view booking history)

			Auth:
			- Auth URL: https://mcp-tennis-auth.pages.dev/login
			- Authorized users: ${env.AUTHORIZED_USER_EMAILS}
			- Users authenticate via React frontend app

			🔗 MCP endpoints:
			- SSE: /sse
			- MCP: /mcp

			To authenticate: Visit https://mcp-tennis-auth.pages.dev/login`, {
				status: 200,
				headers: { 'Content-Type': 'text/plain' },
			});
		}

		// Route SSE (Server-Sent Events) requests for real-time communication
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		// Route MCP protocol requests
		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};