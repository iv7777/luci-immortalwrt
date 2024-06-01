-- Import necessary modules
local luci_sys = require "luci.sys"

-- Initialize configuration map
local map_wolplus = Map("wolplus", translate("Wake on LAN +"), translate("Remotely wake up computers in the local network."))

-- Set template for configuration map
map_wolplus.template = "wolplus/index"

-- Define section for managing host clients
local section_mac_clients = map_wolplus:section(TypedSection, "macclient", translate("Host Clients"))
section_mac_clients.template = "cbi/tblsection"
section_mac_clients.anonymous = true
section_mac_clients.addremove = true

-- Define options for host clients
local option_name = section_mac_clients:option(Value, "name", translate("Name"))
option_name.optional = false

local option_mac_addr = section_mac_clients:option(Value, "macaddr", translate("MAC Address"))
option_mac_addr.rmempty = false

-- Function to validate MAC address
local function validate_mac_address(self, value)
    -- Check if the MAC address is in the format XX-XX-XX-XX-XX-XX and convert to XX:XX:XX:XX:XX:XX
    if value and value:match("^%x%x%-%x%x%-%x%x%-%x%x%-%x%x%-%x%x$") then
        value = value:gsub("-", ":")
    end
    
    -- Validate the MAC address in the format XX:XX:XX:XX:XX:XX
    if value and value:match("^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$") then
        return value
    else
        return nil, translate("Invalid MAC address format. Expected format: XX:XX:XX:XX:XX:XX")
    end
end

-- Attach validation to the MAC address option
option_mac_addr.validate = validate_mac_address

-- Populate known MAC addresses
luci_sys.net.mac_hints(function(mac, desc)
    option_mac_addr:value(mac, "%s (%s)" % {mac, desc})
end)

-- Define option for network interface selection
local option_net_interface = section_mac_clients:option(Value, "maceth", translate("Network Interface"))
option_net_interface.default = "br-lan"
option_net_interface.rmempty = false
for _, interface in ipairs(luci_sys.net.devices()) do
    if interface ~= "lo" then
        option_net_interface:value(interface)
    end
end

-- Define button for waking up host devices
local btn_wake_up = section_mac_clients:option(Button, "_awake", translate("Wake Up Host"))
btn_wake_up.inputtitle = translate("Awake")
btn_wake_up.inputstyle = "apply"
btn_wake_up.disabled = false
btn_wake_up.template = "wolplus/awake"

-- Function to generate UUID
local function generate_uuid(format)
    local uuid = luci_sys.exec("echo -n $(cat /proc/sys/kernel/random/uuid)")
    if format == nil then
        uuid = uuid:gsub("-", "")
    end
    return uuid
end

-- Override create method to use UUID
function section_mac_clients.create(section, id)
    local uuid = generate_uuid()
    id = uuid
    TypedSection.create(section, id)
end

return map_wolplus
