import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { launch, type BrowserWorker } from "@cloudflare/playwright";
import { env } from 'cloudflare:workers'


interface Env {
	AI: any;
	MYBROWSER: BrowserWorker;
	MCP: DurableObjectNamespace;
	BOOKINGS: KVNamespace;
	REC_EMAIL: string;
	REC_PASSWORD: string;
}

function getEnv<Env>() {
	return env as Env
}

export class MyMCP extends McpAgent {
	server: McpServer;

	private browser: any = null;
	private lastBrowserInit: number = 0;
	private readonly BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private initPromise: Promise<void> | null = null;
	private isInitializing = false;

	constructor(state: any) {
		const server = new McpServer({
			name: "Tennis Court Booking",
			version: "3.0.0",
		});
		super(state, { server });
		this.server = server;
		this.initializeTools();
	}

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

				// Use the Cloudflare Playwright launch directly
				this.browser = await launch((env as any).MYBROWSER);
				this.lastBrowserInit = now;
				console.log('Browser launched successfully');
			} catch (error: unknown) {
				console.error('Browser initialization failed:', error);
				this.browser = null;
				throw error; // Re-throw so caller knows it failed
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

	private async getBookingStatus(date: string): Promise<string | null> {
		this.log('hello ' + await (env as any).TENNIS_BOOKINGS?.get(`booking:${date}`));
		try {
			return await (env as any).TENNIS_BOOKINGS?.get(`booking:${date}`);
		} catch (error) {
			console.error('Error getting booking status:', error);
			return null;
		}
	}

	private initializeTools() {
		// Check tennis court availability
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
					await this.init();
					
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
						// Navigate to the requested court
						await page.getByText(targetCourt).click();
						await page.waitForSelector('text=Court Reservations', { timeout: 5000 });
		
						// Navigate to date
						const targetDate = new Date(correctedDate);
						const today = new Date();
						today.setFullYear(2025);
						const nextMonth = targetDate.getMonth() !== today.getMonth();
		
						await page.locator('input').click();
						if (nextMonth) {
							await page.getByRole('button', { name: 'right' }).click();
						}
		
						const day = targetDate.getDate();
						await page.locator(`.react-datepicker__day--0${day < 10 ? '0' : ''}${day}:not(.react-datepicker__day--outside-month)`).first().click();
		
						// Wait for times to load
						await page.waitForSelector('text=/(\\d:)|(No free)/', { timeout: 5000 });
		
						// Extract available times
						const times = await page.getByText('Tennis').first().evaluate((el: HTMLElement) => (el.parentElement as HTMLElement).innerText);
						const availableTimes = times.split('\n').filter((slot: string) => slot.includes(':'));
		
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
		
					await page.close();
		
					// Generate natural language response using Cloudflare AI
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
						// Fallback to a simple text response
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

// CORRECT TENNIS BOOKING FLOW FOR SMS
// Tool 1: Book and request SMS (stops at verification step)
// Tool 2: Enter SMS code you receive on your phone

this.server.tool(
	"book_and_request_sms",
	{
		court: z.string().describe("Court name"),
		time: z.string().describe("Time slot"),
		date: z.string().describe("Date in YYYY-MM-DD format")
	},
	async ({ court, time, date }) => {
		console.log('Starting booking and requesting SMS...');
		
		if (!this.browser) {
			await this.init();
		}
		
		const recEmail = (env as any).REC_EMAIL;
		const recPassword = (env as any).REC_PASSWORD;
		
		let page;
		try {
			page = await this.browser.newPage();
			// More reasonable timeouts
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
			await page.waitForTimeout(3000); // More time for login
			
			console.log('3. Going to court...');
			await page.waitForSelector(`text=${court}`, { timeout: 10000 });
			await page.getByText(court).click();
			await page.waitForTimeout(2000); // More time for court page
			
			console.log('4. Selecting date...');
			const bookDate = new Date(date);
			const today = new Date();
			today.setFullYear(2025);
			const targetDay = bookDate.getDate();
			const nextMonth = bookDate.getMonth() !== today.getMonth();

			// More robust date picker handling
			console.log('Clicking date input...');
			await page.locator('input').click();
			
			// Wait for date picker to open
			await page.waitForSelector('.react-datepicker', { timeout: 5000 });
			await page.waitForTimeout(1000); // Let date picker settle
			
			if (nextMonth) {
				console.log('Going to next month...');
				await page.getByRole('button', { name: 'right' }).click();
				await page.waitForTimeout(500);
			}
			
			console.log(`Selecting day ${targetDay}...`);
			const daySelector = `.react-datepicker__day--0${targetDay < 10 ? '0' : ''}${targetDay}:not(.react-datepicker__day--outside-month)`;
			await page.locator(daySelector).first().click();
			await page.waitForTimeout(1500); // Wait for date selection to complete
			
			console.log('5. Checking time availability...');
			await page.waitForSelector('text=/(\\d:)|(No free)/', { timeout: 8000 });
			const times = await page.getByText('Tennis').first().evaluate((el: HTMLElement) => (el.parentElement as HTMLElement).innerText);
			
			// Normalize time format (handle "3pm" vs "3:00 PM")
			let normalizedTime = time;
			if (time.toLowerCase().includes('pm') || time.toLowerCase().includes('am')) {
				if (!time.includes(':')) {
					// Convert "3pm" to "3:00 PM"
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
			// Just pick first available to save time
			await page.locator('div[role="option"]:not([aria-disabled="true"])').first().click();
			
			console.log('8. Selecting participant...');
			// EXACT GitHub pattern
			await page.getByText('Select participant').click();
			await page.getByText('Account Owner').click();
			
			console.log('9. Requesting SMS...');
			// EXACT GitHub pattern - click book
			await page.locator('button.max-w-max').click();
			await page.getByText('Send Code').click();
			
			// Wait a bit for SMS to be sent (GitHub has 2 second wait)
			await page.waitForTimeout(2000);
			
			// Verify we reached SMS step
			await page.waitForSelector('input[id="totp"]', { timeout: 8000 });
			console.log('✅ SMS verification step reached!');
			
			// Keep page open for SMS entry
			return {
				content: [{
					type: "text",
					text: `📱 SMS CODE REQUESTED! 

Court: ${court}
Time: ${normalizedTime}
Date: ${date}

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
		// DON'T close page - keep it open for SMS entry
	}
);

// SIMPLE SMS CODE ENTRY - FOR ALREADY LOADED VERIFICATION PAGE
// User books manually until SMS step, then uses this tool to complete

this.server.tool(
	"enter_sms_code_and_complete",
	{
		code: z.string().describe("SMS verification code you received on your phone")
	},
	async ({ code }) => {
		console.log(`Entering SMS code: ${code}`);
		
		if (!this.browser) {
			await this.init();
		}
		
		try {
			// Find the page with SMS verification input
			const pages = await this.browser.contexts()[0]?.pages() || [];
			let verificationPage = null;
			
			for (const page of pages) {
				try {
					// Look for the exact input element you specified
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
			
			// EXACT GitHub pattern - use page.type instead of fill
			console.log('entering code');
			await verificationPage.type('input[id="totp"]', code);
			
			// EXACT GitHub timeout pattern
			verificationPage.setDefaultTimeout(180000); // 3 minute timeout like GitHub
			console.log('confirming with 3 min timeout');
			
			// EXACT GitHub confirm click pattern
			try {
				await verificationPage.getByText('Confirm').last().click();
			} catch (e) {
				// keep trying - exact GitHub pattern
				console.log("couldn't click confirm somehow");
				throw new Error(e as string);
			}
			
			// EXACT GitHub success detection pattern
			try {
				await verificationPage.waitForSelector("text=You're all set!");
				console.log('success!, terminating');
				
				return {
					content: [{
						type: "text",
						text: `🎾 BOOKING COMPLETED!

✅ SMS code ${code} accepted
✅ "You're all set!" confirmation received
✅ Your tennis court is booked!`
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
		// Browser diagnostic tool
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

		// Get booking history
		this.server.tool(
			"get_booking_history",
			{
				days: z.number().optional().describe("Number of days to look back (default 30)")
			},
			async ({ days = 30 }) => {
				try {
					const bookings = [];
					const today = new Date();
					
					for (let i = 0; i < days; i++) {
						const checkDate = new Date();
						checkDate.setDate(today.getDate() - i);
						const dateStr = `${checkDate.getMonth() + 1}-${checkDate.getDate()}`;
						const booking = await this.getBookingStatus(dateStr);
						
						if (booking) {
							bookings.push({
								date: checkDate.toDateString(),
								booking: booking
							});
						}
					}

					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								bookingsFound: bookings.length,
								bookings: bookings,
								daysSearched: days
							}, null, 2)
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
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};