local sys = require "luci.sys"
local utl = require "luci.util"

local f = SimpleForm("interfaceview", translate("ZeroTier Interface Information"))
f.description = translate("Detailed view of all ZeroTier interfaces currently active on this device.")
f.reset = false  -- Disable Reset button
f.submit = false -- Disable Submit button

-- Table for interface details
local t = f:section(Table, {}, translate("Summary"))

-- Get ZeroTier interfaces
local interfaces = utl.split(luci.sys.exec("ifconfig | grep '^zt' | awk '{print $1}'"), "\n")

-- Check if interfaces are found
if #interfaces > 0 and interfaces[1] ~= "" then
    -- Prepare table rows
    local rows = {}
    for _, iface in ipairs(interfaces) do
        if iface and iface ~= "" then
            local details = luci.sys.exec("ifconfig " .. iface)
            local row = {
                _iface = iface,
                _mac = details:match("HWaddr%s+([%x:]+)") or "N/A",
                _ipv4 = details:match("inet addr:(%S+)") or "N/A",
                _ipv6 = details:match("inet6 addr:%s*([%x:]+)") or "N/A",
                _mtu = details:match("MTU:(%d+)") or "N/A",
                _rx = details:match("RX bytes:%d+ %(([%d.]+%s?%a+)%)") or "0 B",
                _tx = details:match("TX bytes:%d+ %(([%d.]+%s?%a+)%)") or "0 B"
            }
            table.insert(rows, row)
        end
    end

    -- Define table columns
    t:option(DummyValue, "_iface", translate("Interface Name"))
    t:option(DummyValue, "_mac", translate("MAC Address"))
    t:option(DummyValue, "_ipv4", translate("IPv4 Address"))
    t:option(DummyValue, "_ipv6", translate("IPv6 Address"))
    t:option(DummyValue, "_mtu", translate("MTU"))
    t:option(DummyValue, "_rx", translate("Total Download"))
    t:option(DummyValue, "_tx", translate("Total Upload"))

    -- Populate table
    t.data = rows
else
    f.description = translate("No ZeroTier interfaces found.")
end

-- Add raw output of ifconfig for ZeroTier interfaces only
local raw_details = f:section(SimpleSection)
raw_details.title = translate("Details")
raw_details.titlefont = "small"
local raw_text = raw_details:option(TextValue, "raw")
raw_text.rmempty = true
raw_text.rows = 10

function raw_text.cfgvalue()
    local output = {}
    for _, iface in ipairs(interfaces) do
        if iface and iface ~= "" then
            local details = luci.sys.exec("ifconfig " .. iface)
            table.insert(output, details)
        end
    end
    return table.concat(output)
end
raw_text.readonly = "readonly"

return f
