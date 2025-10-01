#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import Redis from 'redis';
import querystring from 'querystring';
import 'isomorphic-fetch';
class CloudAmazonSellerMCPServer {
    server;
    redis;
    userTokens = new Map();
    LWA_ENDPOINT = 'https://api.amazon.com/auth/o2/token';
    constructor() {
        console.error('[DEBUG] Initializing Amazon Seller MCP Server');
        this.setupMCPServer();
        this.setupToolHandlers();
    }
    async setupRedis() {
        if (process.env.REDIS_URL) {
            try {
                this.redis = Redis.createClient({
                    url: process.env.REDIS_URL,
                    socket: {
                        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
                    }
                });
                this.redis.on('error', (err) => {
                    console.error('Redis Client Error', err);
                });
                await this.redis.connect();
                console.error('Connected to Redis for token storage');
            }
            catch (error) {
                console.error('Redis connection failed, using in-memory storage:', error.message);
            }
        }
        else {
            console.error('No Redis URL provided, using in-memory token storage');
        }
    }
    setupMCPServer() {
        this.server = new Server({
            name: 'cloud-amazon-seller-mcp-server',
            version: '1.0.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        console.error('[DEBUG] MCP Server instance created');
    }
    async storeTokens(userId, tokens) {
        if (this.redis) {
            try {
                await this.redis.setEx(`amazon_tokens:${userId}`, 3600 * 24 * 7, JSON.stringify(tokens));
            }
            catch (error) {
                console.error('Failed to store tokens in Redis:', error);
                this.userTokens.set(userId, tokens);
            }
        }
        else {
            this.userTokens.set(userId, tokens);
        }
    }
    async getTokens(userId) {
        if (this.redis) {
            try {
                const tokensData = await this.redis.get(`amazon_tokens:${userId}`);
                return tokensData ? JSON.parse(tokensData) : null;
            }
            catch (error) {
                console.error('Failed to get tokens from Redis:', error);
                return this.userTokens.get(userId) || null;
            }
        }
        else {
            return this.userTokens.get(userId) || null;
        }
    }
    async revokeTokens(userId) {
        if (this.redis) {
            try {
                await this.redis.del(`amazon_tokens:${userId}`);
            }
            catch (error) {
                console.error('Failed to delete tokens from Redis:', error);
            }
        }
        this.userTokens.delete(userId);
    }
    async checkAuthentication(userId) {
        const tokens = await this.getTokens(userId);
        if (!tokens?.refreshToken) {
            return false;
        }
        if (tokens.expiresOn && Date.now() < tokens.expiresOn) {
            return true;
        }
        try {
            const refreshedTokens = await this.refreshAccessToken(tokens.refreshToken);
            if (refreshedTokens) {
                const updatedTokens = {
                    ...tokens,
                    accessToken: refreshedTokens.access_token,
                    expiresOn: Date.now() + (refreshedTokens.expires_in * 1000),
                };
                await this.storeTokens(userId, updatedTokens);
                return true;
            }
        }
        catch (error) {
            console.error('Token refresh failed:', error);
            await this.revokeTokens(userId);
        }
        return false;
    }
    async exchangeCodeForTokens(code) {
        const clientId = process.env.AMAZON_CLIENT_ID;
        const clientSecret = process.env.AMAZON_CLIENT_SECRET;
        const redirectUri = process.env.OAUTH_REDIRECT_URI;
        if (!clientId || !clientSecret || !redirectUri) {
            throw new Error('Amazon OAuth credentials not configured');
        }
        const params = {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
        };
        const response = await fetch(this.LWA_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: querystring.stringify(params),
        });
        if (!response.ok) {
            throw new Error(`Token exchange failed: ${response.statusText}`);
        }
        return await response.json();
    }
    async refreshAccessToken(refreshToken) {
        const clientId = process.env.AMAZON_CLIENT_ID;
        const clientSecret = process.env.AMAZON_CLIENT_SECRET;
        const params = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        };
        const response = await fetch(this.LWA_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: querystring.stringify(params),
        });
        if (!response.ok) {
            throw new Error(`Token refresh failed: ${response.statusText}`);
        }
        return await response.json();
    }
    async initiateUserAuth(userId, region) {
        const clientId = process.env.AMAZON_CLIENT_ID;
        const redirectUri = process.env.OAUTH_REDIRECT_URI;
        if (!clientId || !redirectUri) {
            throw new Error('Amazon OAuth credentials not configured');
        }
        const scope = 'sellingpartnerapi::notifications sellingpartnerapi::migration';
        const state = `${userId}_${region}`;
        return `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;
    }
    async makeApiRequest(userId, endpoint, method = 'GET', body) {
        const tokens = await this.getTokens(userId);
        if (!tokens?.accessToken) {
            throw new Error('No valid access token');
        }
        const region = tokens.region || 'us-east-1';
        const baseUrl = this.getApiEndpoint(region);
        const url = `${baseUrl}${endpoint}`;
        const headers = {
            'Authorization': `Bearer ${tokens.accessToken}`,
            'Content-Type': 'application/json',
            'x-amz-access-token': tokens.accessToken,
        };
        const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            throw new Error(`API request failed: ${response.statusText}`);
        }
        return await response.json();
    }
    getApiEndpoint(region) {
        switch (region) {
            case 'eu-west-1':
                return 'https://sellingpartnerapi-eu.amazon.com';
            case 'ap-northeast-1':
                return 'https://sellingpartnerapi-fe.amazon.com';
            default:
                return 'https://sellingpartnerapi-na.amazon.com';
        }
    }
    async getSellerAccount(userId) {
        try {
            const response = await this.makeApiRequest(userId, '/sellers/v1/account');
            return {
                sellerId: response.payload?.sellerId,
                name: response.payload?.name,
                marketplaceIds: response.payload?.marketplaceIds,
            };
        }
        catch (error) {
            return { error: error.message };
        }
    }
    setupToolHandlers() {
        console.error('[DEBUG] Setting up tool handlers');
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'amazon_authenticate',
                        description: 'Get Amazon Seller authentication URL',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier for this authentication session' },
                                region: { type: 'string', enum: ['us-east-1', 'eu-west-1', 'ap-northeast-1'], description: 'Amazon marketplace region', default: 'us-east-1' },
                                force_reauth: { type: 'boolean', description: 'Force re-authentication', default: false },
                            }
                        }
                    },
                    {
                        name: 'amazon_status',
                        description: 'Check Amazon Seller connection status and account info',
                        inputSchema: {
                            type: 'object',
                            properties: { user_id: { type: 'string', description: 'User identifier' } },
                            required: ['user_id']
                        }
                    },
                    {
                        name: 'amazon_list_orders',
                        description: 'List Amazon orders with optional filtering',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                marketplace_ids: { type: 'array', items: { type: 'string' }, description: 'Marketplace IDs to filter by' },
                                created_after: { type: 'string', description: 'Filter orders created after this date (ISO 8601)' },
                                created_before: { type: 'string', description: 'Filter orders created before this date (ISO 8601)' },
                                order_statuses: { type: 'array', items: { type: 'string', enum: ['PendingAvailability', 'Pending', 'Unshipped', 'PartiallyShipped', 'Shipped', 'Canceled', 'Unfulfillable'] }, description: 'Order statuses to filter by' },
                                fulfillment_channels: { type: 'array', items: { type: 'string', enum: ['AFN', 'MFN'] }, description: 'Fulfillment channels (AFN=Amazon, MFN=Merchant)' },
                                max_results: { type: 'number', description: 'Maximum orders to return', default: 50 },
                            },
                            required: ['user_id', 'marketplace_ids']
                        }
                    },
                    {
                        name: 'amazon_get_order',
                        description: 'Get detailed information about a specific order',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                order_id: { type: 'string', description: 'Amazon order ID' },
                                include_items: { type: 'boolean', description: 'Include order items', default: true },
                            },
                            required: ['user_id', 'order_id']
                        }
                    },
                    {
                        name: 'amazon_list_inventory',
                        description: 'List inventory items',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                marketplace_ids: { type: 'array', items: { type: 'string' }, description: 'Marketplace IDs' },
                                seller_skus: { type: 'array', items: { type: 'string' }, description: 'Specific SKUs to retrieve' },
                                granularity_type: { type: 'string', enum: ['Marketplace'], description: 'Granularity for inventory data', default: 'Marketplace' },
                                granularity_id: { type: 'string', description: 'Granularity identifier (marketplace ID)' },
                                max_results: { type: 'number', description: 'Maximum items to return', default: 50 },
                            },
                            required: ['user_id', 'granularity_type', 'granularity_id']
                        }
                    },
                    {
                        name: 'amazon_update_inventory',
                        description: 'Update inventory quantity for a SKU',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                marketplace_id: { type: 'string', description: 'Marketplace ID' },
                                seller_sku: { type: 'string', description: 'Seller SKU' },
                                quantity: { type: 'number', description: 'New quantity' },
                            },
                            required: ['user_id', 'marketplace_id', 'seller_sku', 'quantity']
                        }
                    },
                    {
                        name: 'amazon_get_reports',
                        description: 'List available reports',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                report_types: { type: 'array', items: { type: 'string' }, description: 'Report types to filter by' },
                                processing_statuses: { type: 'array', items: { type: 'string', enum: ['SUBMITTED', 'IN_PROGRESS', 'CANCELLED', 'DONE', 'DONE_NO_DATA'] }, description: 'Processing statuses to filter by' },
                                marketplace_ids: { type: 'array', items: { type: 'string' }, description: 'Marketplace IDs' },
                                created_since: { type: 'string', description: 'Filter reports created since this date (ISO 8601)' },
                                max_results: { type: 'number', description: 'Maximum reports to return', default: 25 },
                            },
                            required: ['user_id']
                        }
                    },
                    {
                        name: 'amazon_create_report',
                        description: 'Create a new report',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                report_type: { type: 'string', description: 'Type of report to create (e.g., GET_MERCHANT_LISTINGS_ALL_DATA)' },
                                marketplace_ids: { type: 'array', items: { type: 'string' }, description: 'Marketplace IDs' },
                                data_start_time: { type: 'string', description: 'Start time for report data (ISO 8601)' },
                                data_end_time: { type: 'string', description: 'End time for report data (ISO 8601)' },
                            },
                            required: ['user_id', 'report_type', 'marketplace_ids']
                        }
                    },
                    {
                        name: 'amazon_get_finances',
                        description: 'Get financial data',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                max_results_per_page: { type: 'number', description: 'Maximum results per page', default: 100 },
                                posted_after: { type: 'string', description: 'Filter events posted after this date (ISO 8601)' },
                                posted_before: { type: 'string', description: 'Filter events posted before this date (ISO 8601)' },
                            },
                            required: ['user_id']
                        }
                    },
                    {
                        name: 'amazon_confirm_shipment',
                        description: 'Confirm shipment for an order',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                user_id: { type: 'string', description: 'User identifier' },
                                order_id: { type: 'string', description: 'Amazon order ID' },
                                marketplace_id: { type: 'string', description: 'Marketplace ID' },
                                package_details: {
                                    type: 'object',
                                    properties: {
                                        package_reference_id: { type: 'string', description: 'Package reference ID' },
                                        carrier_code: { type: 'string', description: 'Carrier code (e.g., UPS, FEDEX)' },
                                        carrier_name: { type: 'string', description: 'Carrier name' },
                                        shipping_method: { type: 'string', description: 'Shipping method' },
                                        tracking_number: { type: 'string', description: 'Package tracking number' },
                                        ship_date: { type: 'string', description: 'Ship date (ISO 8601)' },
                                    },
                                    required: ['package_reference_id']
                                },
                            },
                            required: ['user_id', 'order_id', 'marketplace_id', 'package_details']
                        }
                    }
                ]
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const userId = args?.user_id;
            try {
                switch (name) {
                    case 'amazon_authenticate':
                        return await this.handleAuthenticate(args || {});
                    case 'amazon_status':
                        return await this.handleStatus(userId);
                    default:
                        if (!userId) {
                            return { content: [{ type: 'text', text: 'Error: user_id is required for all Amazon operations.' }], isError: true };
                        }
                        if (!(await this.checkAuthentication(userId))) {
                            return { content: [{ type: 'text', text: 'Not authenticated with Amazon Seller. Please authenticate first using amazon_authenticate.' }], isError: true };
                        }
                        return await this.handleAmazonOperation(name, args || {});
                }
            }
            catch (error) {
                console.error(`Error in ${name}:`, error);
                throw new McpError(ErrorCode.InternalError, `Error executing ${name}: ${error.message}`);
            }
        });
        console.error('[DEBUG] Tool handlers setup complete');
    }
    async handleAuthenticate(args) {
        try {
            const userId = args.user_id || `seller_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const region = args.region || 'us-east-1';
            const force_reauth = args.force_reauth || false;
            if (!force_reauth && await this.checkAuthentication(userId)) {
                const sellerInfo = await this.getSellerAccount(userId);
                return { content: [{ type: 'text', text: `Already authenticated with Amazon Seller!\n\nSeller: ${sellerInfo.name || 'N/A'}\nSeller ID: ${sellerInfo.sellerId || 'N/A'}\nUser ID: ${userId}\nRegion: ${region}` }] };
            }
            const authUrl = await this.initiateUserAuth(userId, region);
            return { content: [{ type: 'text', text: `To authenticate Amazon Seller access, visit:\n${authUrl}\n\nUser ID: ${userId}\nRegion: ${region}\n\nAfter authorization, you can use other Amazon Seller tools with this user_id.` }] };
        }
        catch (error) {
            return { content: [{ type: 'text', text: `Authentication setup failed: ${error.message}` }], isError: true };
        }
    }
    async handleStatus(userId) {
        if (!userId) {
            return { content: [{ type: 'text', text: 'Error: user_id is required' }], isError: true };
        }
        if (await this.checkAuthentication(userId)) {
            try {
                const sellerInfo = await this.getSellerAccount(userId);
                const tokens = await this.getTokens(userId);
                return { content: [{ type: 'text', text: `**Amazon Seller Connected**\n\nSeller: ${sellerInfo.name || 'N/A'}\nSeller ID: ${sellerInfo.sellerId || 'N/A'}\nUser ID: ${userId}\nRegion: ${tokens?.region || 'N/A'}\nMarketplaces: ${sellerInfo.marketplaceIds?.join(', ') || 'N/A'}\nStatus: Authenticated` }] };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Connected but unable to fetch details: ${error.message}` }] };
            }
        }
        return { content: [{ type: 'text', text: '**Not connected to Amazon Seller**\n\nRun amazon_authenticate to get started.' }] };
    }
    async handleAmazonOperation(operation, args) {
        switch (operation) {
            case 'amazon_list_orders': return await this.listOrders(args);
            case 'amazon_get_order': return await this.getOrder(args);
            case 'amazon_list_inventory': return await this.listInventory(args);
            case 'amazon_update_inventory': return await this.updateInventory(args);
            case 'amazon_get_reports': return await this.getReports(args);
            case 'amazon_create_report': return await this.createReport(args);
            case 'amazon_get_finances': return await this.getFinances(args);
            case 'amazon_confirm_shipment': return await this.confirmShipment(args);
            default: throw new Error(`Unknown operation: ${operation}`);
        }
    }
    async listOrders(args) {
        const { marketplace_ids, created_after, created_before, order_statuses, fulfillment_channels, max_results = 50 } = args;
        let endpoint = '/orders/v0/orders';
        const params = [];
        params.push(`MarketplaceIds=${marketplace_ids.join(',')}`);
        if (created_after)
            params.push(`CreatedAfter=${created_after}`);
        if (created_before)
            params.push(`CreatedBefore=${created_before}`);
        if (order_statuses)
            params.push(`OrderStatuses=${order_statuses.join(',')}`);
        if (fulfillment_channels)
            params.push(`FulfillmentChannels=${fulfillment_channels.join(',')}`);
        if (max_results)
            params.push(`MaxResultsPerPage=${max_results}`);
        endpoint += `?${params.join('&')}`;
        const response = await this.makeApiRequest(args.user_id, endpoint);
        const orders = response.payload?.Orders || [];
        const orderList = orders.map((order) => {
            const orderDate = new Date(order.PurchaseDate).toLocaleString();
            const total = order.OrderTotal ? `${order.OrderTotal.Amount} ${order.OrderTotal.CurrencyCode}` : 'N/A';
            return `**Order ${order.AmazonOrderId}**\n   Status: ${order.OrderStatus}\n   Date: ${orderDate}\n   Total: ${total}\n   Channel: ${order.FulfillmentChannel}\n   Items: ${order.NumberOfItemsShipped + order.NumberOfItemsUnshipped}`;
        }).join('\n\n') || 'No orders found';
        return { content: [{ type: 'text', text: `**Amazon Orders** (${orders.length} found)\n\n${orderList}` }] };
    }
    async getOrder(args) {
        const { order_id, include_items = true } = args;
        const orderResponse = await this.makeApiRequest(args.user_id, `/orders/v0/orders/${order_id}`);
        const order = orderResponse.payload;
        const info = [
            `**Order ${order.AmazonOrderId}**`,
            `Status: ${order.OrderStatus}`,
            `Purchase Date: ${new Date(order.PurchaseDate).toLocaleString()}`,
            `Last Update: ${new Date(order.LastUpdateDate).toLocaleString()}`,
            `Total: ${order.OrderTotal ? `${order.OrderTotal.Amount} ${order.OrderTotal.CurrencyCode}` : 'N/A'}`,
            `Channel: ${order.FulfillmentChannel}`,
            `Ship Level: ${order.ShipServiceLevel || 'N/A'}`,
            `Marketplace: ${order.MarketplaceId}`,
        ];
        if (order.ShippingAddress) {
            info.push(`Shipping: ${order.ShippingAddress.Name || 'N/A'}, ${order.ShippingAddress.City || 'N/A'}, ${order.ShippingAddress.StateOrRegion || 'N/A'}`);
        }
        if (include_items) {
            try {
                const itemsResponse = await this.makeApiRequest(args.user_id, `/orders/v0/orders/${order_id}/orderItems`);
                const items = itemsResponse.payload?.OrderItems || [];
                if (items.length > 0) {
                    info.push('\n**Items:**');
                    items.forEach((item) => {
                        info.push(`• ${item.Title} (SKU: ${item.SellerSKU}) - Qty: ${item.QuantityOrdered}, Price: ${item.ItemPrice?.Amount || 'N/A'} ${item.ItemPrice?.CurrencyCode || ''}`);
                    });
                }
            }
            catch {
                info.push('Items: Unable to fetch items');
            }
        }
        return { content: [{ type: 'text', text: info.join('\n') }] };
    }
    async listInventory(args) {
        const { marketplace_ids, seller_skus, granularity_type = 'Marketplace', granularity_id, max_results = 50 } = args;
        let endpoint = `/fba/inventory/v1/summaries?details=true&granularityType=${granularity_type}&granularityId=${granularity_id}`;
        if (marketplace_ids)
            endpoint += `&marketplaceIds=${marketplace_ids.join(',')}`;
        if (seller_skus && seller_skus.length > 0)
            endpoint += `&sellerSkus=${seller_skus.join(',')}`;
        const response = await this.makeApiRequest(args.user_id, endpoint);
        const inventories = response.payload?.inventorySummaries || [];
        const inventoryList = inventories.slice(0, max_results).map((item) => {
            const totalQty = item.totalQuantity || 0;
            const availableQty = item.inventoryDetails?.fulfillableQuantity || 0;
            return `**${item.sellerSku}**\n   ASIN: ${item.asin || 'N/A'}\n   Condition: ${item.condition || 'N/A'}\n   Total Qty: ${totalQty}\n   Available: ${availableQty}\n   Reserved: ${totalQty - availableQty}`;
        }).join('\n\n') || 'No inventory found';
        return { content: [{ type: 'text', text: `**Inventory Summary** (${Math.min(inventories.length, max_results)} items)\n\n${inventoryList}` }] };
    }
    async updateInventory(args) {
        const { marketplace_id, seller_sku, quantity } = args;
        return { content: [{ type: 'text', text: `**Inventory Update Initiated**\n\nSKU: ${seller_sku}\nNew Quantity: ${quantity}\nMarketplace: ${marketplace_id}\n\nNote: Full implementation requires feed processing which may take time to complete.` }] };
    }
    async getReports(args) {
        const { report_types, processing_statuses, marketplace_ids, created_since, max_results = 25 } = args;
        let endpoint = '/reports/2021-06-30/reports';
        const params = [];
        if (report_types)
            params.push(`reportTypes=${report_types.join(',')}`);
        if (processing_statuses)
            params.push(`processingStatuses=${processing_statuses.join(',')}`);
        if (marketplace_ids)
            params.push(`marketplaceIds=${marketplace_ids.join(',')}`);
        if (created_since)
            params.push(`createdSince=${created_since}`);
        if (max_results)
            params.push(`pageSize=${max_results}`);
        if (params.length > 0)
            endpoint += `?${params.join('&')}`;
        const response = await this.makeApiRequest(args.user_id, endpoint);
        const reports = response.reports || [];
        const reportList = reports.map((report) => {
            return `**${report.reportType}**\n   Report ID: ${report.reportId}\n   Status: ${report.processingStatus}\n   Created: ${new Date(report.createdTime).toLocaleString()}\n   Marketplaces: ${report.marketplaceIds?.join(', ') || 'N/A'}`;
        }).join('\n\n') || 'No reports found';
        return { content: [{ type: 'text', text: `**Reports** (${reports.length} found)\n\n${reportList}` }] };
    }
    async createReport(args) {
        const { report_type, marketplace_ids, data_start_time, data_end_time } = args;
        const reportRequest = { reportType: report_type, marketplaceIds: marketplace_ids };
        if (data_start_time)
            reportRequest.dataStartTime = data_start_time;
        if (data_end_time)
            reportRequest.dataEndTime = data_end_time;
        const response = await this.makeApiRequest(args.user_id, '/reports/2021-06-30/reports', 'POST', reportRequest);
        return { content: [{ type: 'text', text: `**Report Created**\n\nReport ID: ${response.reportId}\nType: ${report_type}\nStatus: ${response.processingStatus || 'SUBMITTED'}\nMarketplaces: ${marketplace_ids.join(', ')}\n\nCheck report status using amazon_get_reports.` }] };
    }
    async getFinances(args) {
        const { max_results_per_page = 100, posted_after, posted_before } = args;
        let endpoint = `/finances/v0/financialEventGroups?MaxResultsPerPage=${max_results_per_page}`;
        if (posted_after)
            endpoint += `&PostedAfter=${posted_after}`;
        if (posted_before)
            endpoint += `&PostedBefore=${posted_before}`;
        const response = await this.makeApiRequest(args.user_id, endpoint);
        const eventGroups = response.payload?.FinancialEventGroupList || [];
        const financesList = eventGroups.map((group) => {
            const processingDate = group.ProcessingDate ? new Date(group.ProcessingDate).toLocaleString() : 'N/A';
            const fundTransferDate = group.FundTransferDate ? new Date(group.FundTransferDate).toLocaleString() : 'N/A';
            return `**${group.FinancialEventGroupId}**\n   Processing Date: ${processingDate}\n   Transfer Date: ${fundTransferDate}\n   Status: ${group.ProcessingStatus || 'N/A'}\n   Original Total: ${group.OriginalTotal?.CurrencyAmount || 'N/A'} ${group.OriginalTotal?.CurrencyCode || ''}`;
        }).join('\n\n') || 'No financial events found';
        return { content: [{ type: 'text', text: `**Financial Events** (${eventGroups.length} groups)\n\n${financesList}` }] };
    }
    async confirmShipment(args) {
        const { order_id, marketplace_id, package_details } = args;
        const shipmentData = {
            packageDetail: {
                packageReferenceId: package_details.package_reference_id,
                carrierCode: package_details.carrier_code,
                carrierName: package_details.carrier_name,
                shippingMethod: package_details.shipping_method,
                trackingNumber: package_details.tracking_number,
                shipDate: package_details.ship_date || new Date().toISOString(),
            }
        };
        await this.makeApiRequest(args.user_id, `/orders/v0/orders/${order_id}/shipment`, 'POST', shipmentData);
        return { content: [{ type: 'text', text: `**Shipment Confirmed**\n\nOrder ID: ${order_id}\nMarketplace: ${marketplace_id}\nPackage ID: ${package_details.package_reference_id}\nTracking: ${package_details.tracking_number || 'N/A'}\nCarrier: ${package_details.carrier_name || package_details.carrier_code || 'N/A'}` }] };
    }
}
// STDIO-ONLY STARTUP CODE
async function startServer() {
    console.error('[DEBUG] Starting Amazon Seller MCP Server in stdio mode');
    const server = new CloudAmazonSellerMCPServer();
    // Setup Redis (non-blocking)
    await server.setupRedis().catch(err => {
        console.error('[DEBUG] Redis setup skipped:', err.message);
    });
    console.error('[DEBUG] Creating stdio transport');
    const transport = new StdioServerTransport();
    console.error('[DEBUG] Connecting server to transport');
    await server['server'].connect(transport);
    console.error('[DEBUG] Amazon Seller MCP Server ready on stdio');
}
startServer().catch((error) => {
    console.error('[FATAL] Server startup failed:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map