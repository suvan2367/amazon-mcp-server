
**Amazon Seller MCP Server**

A MCP server for integrating automation workflows with the Amazon Seller API. This server facilitates seller authentication, order and inventory management, financial analytics, and reporting through structured tool endpoints and robust authentication.

**Features**

OAuth2 Authentication: Secure OAuth2/Consent flow for Amazon Seller access

Token Management: In-memory or Redis-based token storage; automatic refresh

Account Status: Check the connection and status of your seller account

Order Management: List, fetch, and view Amazon orders with filters

Inventory Management: View, update inventory via Seller SKU and marketplace

Shipment Handling: Confirm shipment, add tracking, mark as shipped

Reporting & Analytics: Create and fetch reports; retrieve financial event groups

Multi-region Support: Easily switch between Amazon global regions and marketplaces

Extensible Tool API: All endpoints exposed via ModelContextProtocol tool handlers


**Tool Endpoints**

The MCP server exposes Amazon Seller operations as tool handlers, usable programmatically or via LLM/chat tools:

**Authentication & Status**

amazon_authenticate: Generates an OAuth URL for user consent and connection. Inputs: user_id, region, force_reauth.

amazon_status: Checks connectivity and shows linked seller/account details.

**Order Operations**

amazon_list_orders: List orders (by marketplace, date, status, fulfillment channel).

amazon_get_order: Fetch order details (with optional item listing).

**Inventory Operations**

amazon_list_inventory: List inventory items (filter by SKUs, marketplace, granularity).

amazon_update_inventory: Update inventory quantity for SKUs.

**Reports**

amazon_get_reports: List available reports (report types, processing status, marketplace).

amazon_create_report: Submit a new report job (type, marketplace, time window).

**Financials**

amazon_get_finances: Retrieve financial event groups (fund transfer, posting window, status).

**Shipments**

amazon_confirm_shipment: Confirm shipment with order/package details, tracking information.
