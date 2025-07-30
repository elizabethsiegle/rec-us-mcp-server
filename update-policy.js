#!/usr/bin/env node

import { program } from "commander";
import { fetch } from "undici";

const policy = {
	custom_resources: [
		{
			available_actions: ["create", "read", "update", "delete"],
			resource_id: "objective",
		},
		{
			available_actions: ["create", "read", "update", "delete"],
			resource_id: "key_result",
		},
	],
	custom_roles: [
		{
			permissions: [
				{
					actions: ["*"],
					resource_id: "key_result",
				},
				{
					actions: ["read"],
					resource_id: "objective",
				},
				{
					actions: ["create", "search"],
					resource_id: "stytch.member",
				},
			],
			role_id: "manager",
		},
	],
	custom_scopes: [
		{
			permissions: [
				{
					actions: ["*"],
					resource_id: "objective",
				},
			],
			scope: "manage:objectives",
		},
		{
			permissions: [
				{
					actions: ["*"],
					resource_id: "key_result",
				},
			],
			scope: "manage:krs",
		},
		{
			permissions: [
				{
					actions: ["read"],
					resource_id: "key_result",
				},
				{
					actions: ["read"],
					resource_id: "objective",
				},
			],
			scope: "read:okrs",
		},
		{
			permissions: [
				{
					actions: ["read", "update"],
					resource_id: "key_result",
				},
			],
			scope: "report_kr_status",
		},
	],
	stytch_admin: {
		description:
			"Granted to Members who create an organization through the Stytch discovery flow. Admins will also have the stytch_member role. Cannot be deleted.",
		permissions: [
			{
				actions: ["*"],
				resource_id: "stytch.organization",
			},
			{
				actions: ["*"],
				resource_id: "stytch.member",
			},
			{
				actions: ["*"],
				resource_id: "stytch.sso",
			},
			{
				actions: ["*"],
				resource_id: "stytch.scim",
			},
			{
				actions: ["*"],
				resource_id: "objective",
			},
			{
				actions: ["*"],
				resource_id: "key_result",
			},
		],
		role_id: "stytch_admin",
	},
	stytch_member: {
		description:
			"Granted to all Members upon creation; grants permissions already implicitly granted to logged in Members via the SDK. Cannot be deleted.",
		permissions: [
			{
				actions: ["*"],
				resource_id: "stytch.self",
			},
			{
				actions: ["read"],
				resource_id: "objective",
			},
			{
				actions: ["read", "update"],
				resource_id: "key_result",
			},
		],
		role_id: "stytch_member",
	},
};

program
	.description("Make an authenticated PUT request")
	.requiredOption("--key-id <keyId>", "Management API Key ID")
	.requiredOption("--secret <secret>", "Management API Secret")
	.requiredOption("--project-id <projectId>", "Project ID you are updating")
	.parse(process.argv);
const options = program.opts();
const rbac_url = `https://management.stytch.com/v1/projects/${options.projectId}/rbac_policy`;
const body = {
	policy: policy,
	project_id: options.projectId,
};

async function makePutRequest() {
	try {
		const credentials = Buffer.from(`${options.keyId}:${options.secret}`).toString("base64");
		const headers = {
			Authorization: `Basic ${credentials}`,
			"Content-Type": "application/json",
		};

		const response = await fetch(rbac_url, {
			body: JSON.stringify(body),
			headers,
			method: "PUT",
		});

		const responseText = await response.json();

		if (!response.ok) {
			console.error("Error Response:", responseText);
			throw new Error(`HTTP Error! status: ${response.status}`);
		}

		console.log(`Success! status code: ${response.status}`);
		console.log(`Response: ${JSON.stringify(responseText, null, 2)}`);
	} catch (error) {
		console.error("Error making request:", error.message);
		process.exit(1);
	}
}

makePutRequest();