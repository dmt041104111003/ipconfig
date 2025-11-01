require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.set('trust proxy', true);

async function getWifiInfo() {
  const result = {
    ssid: null,
    bssid: null,
    ip: null,
    linkLocalIPv6: null,
    mac: null
  };

  try {
    if (process.platform === 'win32') {
      try {
        const { stdout: ssidOutput } = await execPromise('netsh wlan show interfaces');
        const ssidMatch = ssidOutput.match(/SSID\s*:\s*(.+)/i);
        if (ssidMatch) {
          result.ssid = ssidMatch[1].trim();
        }
      } catch (e) {
        // Ignore
      }

      try {
        const { stdout: networksOutput } = await execPromise('netsh wlan show networks mode=Bssid');
        
        if (result.ssid) {
          const lines = networksOutput.split('\n');
          let foundSsid = false;
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.includes('SSID') && line.includes(result.ssid)) {
              foundSsid = true;
              continue;
            }
            
            if (foundSsid) {
              if (line.trim().startsWith('SSID') && !line.includes(result.ssid)) {
                break;
              }
              
              if (line.includes('BSSID')) {
                const macPattern = /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/i;
                const match = line.match(macPattern);
                if (match) {
                  result.bssid = match[0];
                  break;
                }
              }
            }
          }
        }
      } catch (e) {
        try {
          const { stdout: interfacesOutput } = await execPromise('netsh wlan show interfaces');
          const lines = interfacesOutput.split('\n');
          
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.toLowerCase().startsWith('bssid')) {
              const parts = trimmedLine.split(':');
              if (parts.length > 1) {
                const bssid = parts.slice(1).join(':').trim();
                if (/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/i.test(bssid)) {
                  result.bssid = bssid;
                  break;
                }
              }
            }
          }
        } catch (e2) {
          // Ignore
        }
      }

      const { stdout: ipconfigOutput } = await execPromise('ipconfig');
      const lines = ipconfigOutput.split('\n');
      
      let foundWifiSection = false;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.includes('Wireless LAN adapter Wi-Fi') || line.includes('adapter Wi-Fi:')) {
          foundWifiSection = true;
          continue;
        }
        
        if (foundWifiSection) {
          if (line.includes('adapter') && !line.includes('Wi-Fi')) {
            break;
          }
          
          if (line.includes('IPv4 Address') && !result.ip) {
            const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch && ipMatch[1] !== '0.0.0.0') {
              result.ip = ipMatch[1];
            }
          }
          
          if (line.includes('Default Gateway')) {
            const gatewayMatch = line.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (gatewayMatch && gatewayMatch[1] !== '0.0.0.0') {
              result.ip = gatewayMatch[1];
            }
          }
          
          if (line.includes('Link-local IPv6 Address')) {
            const parts = line.split(':');
            if (parts.length > 1) {
              const ipv6Match = line.match(/:\s*([0-9a-fA-F:]+(?:%\d+)?)/i);
              if (ipv6Match && ipv6Match[1]) {
                result.linkLocalIPv6 = ipv6Match[1].trim();
              } else {
                const lastColonIndex = line.lastIndexOf(':');
                if (lastColonIndex !== -1) {
                  const afterColon = line.substring(lastColonIndex + 1).trim();
                  if (afterColon.includes(':') || afterColon.startsWith('fe80')) {
                    result.linkLocalIPv6 = afterColon;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      try {
        const { stdout: iwOutput } = await execPromise('iwgetid -r');
        result.ssid = iwOutput.trim();
      } catch (e) {
        // Ignore
      }

      try {
        const { stdout: routeOutput } = await execPromise('ip route | grep default');
        const match = routeOutput.match(/\d+\.\d+\.\d+\.\d+/);
        if (match && match[0] !== '0.0.0.0') {
          result.ip = match[0];
        }
      } catch (e) {
        // Ignore
      }
    }
  } catch (error) {
    console.error('Error getting WiFi info:', error.message);
  }

  return result;
}

async function getWifiGateway() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execPromise('ipconfig');
      const lines = stdout.split('\n');
      
      let foundWifiSection = false;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.includes('Wireless LAN adapter Wi-Fi') || line.includes('adapter Wi-Fi:')) {
          foundWifiSection = true;
          continue;
        }
        
        if (foundWifiSection) {
          if (line.includes('adapter') && !line.includes('Wi-Fi')) {
            break;
          }
          
          if (line.includes('Default Gateway')) {
            const match = line.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (match && match[1] && match[1] !== '0.0.0.0') {
              return match[1];
            }
          }
        }
      }
      
      try {
        const psCommand = `Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Where-Object { $_.InterfaceAlias -like "*Wi-Fi*" -or $_.InterfaceAlias -like "*Wireless*" } | Select-Object -First 1 | Select-Object -ExpandProperty NextHop`;
        const command = `powershell -Command "${psCommand}"`;
        const { stdout: psStdout } = await execPromise(command);
        const gateway = psStdout.trim();
        if (gateway && gateway !== '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) {
          return gateway;
        }
      } catch (psError) {
        // Ignore
      }
    } else {
      const { stdout } = await execPromise('ip route | grep default');
      const match = stdout.match(/\d+\.\d+\.\d+\.\d+/);
      if (match && match[0] !== '0.0.0.0') {
        return match[0];
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting gateway:', error.message);
    return null;
  }
}

app.get('/', async (req, res) => {
  try {
    const wifiInfo = await getWifiInfo();
    res.json({
      message: 'API Kiểm tra thông tin WiFi từ tất cả thiết bị',
      endpoints: {
        'GET /api/wifi-ip': 'Lấy thông tin WiFi của server (nếu server có WiFi)',
        'POST /api/wifi-ip': 'Client gửi thông tin WiFi của thiết bị (body: {ssid, bssid, ip, linkLocalIPv6})'
      },
      serverWifi: wifiInfo,
      note: 'Trên server cloud không có WiFi adapter. Client cần tự lấy và gửi lên qua POST.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/wifi-ip', async (req, res) => {
  try {
    const wifiInfo = await getWifiInfo();
    
    res.json({
      success: true,
      data: {
        ssid: wifiInfo.ssid || 'N/A',
        bssid: wifiInfo.bssid || wifiInfo.mac || 'N/A',
        ip: wifiInfo.ip || 'N/A',
        linkLocalIPv6: wifiInfo.linkLocalIPv6 || 'N/A'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/wifi-ip', async (req, res) => {
  try {
    const { ssid, bssid, ip, linkLocalIPv6 } = req.body;
    const clientIP = req.ip || 
                     req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.headers['x-real-ip'] ||
                     req.connection.remoteAddress ||
                     'unknown';
    
    res.json({
      success: true,
      message: 'Đã nhận thông tin WiFi từ thiết bị',
      data: {
        ssid: ssid || 'N/A',
        bssid: bssid || 'N/A',
        ip: ip || 'N/A',
        linkLocalIPv6: linkLocalIPv6 || 'N/A',
        clientIP: clientIP,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Server đang chạy trên port ${PORT}`);
  const wifiInfo = await getWifiInfo();
  console.log(`Thông tin WiFi:`);
  if (wifiInfo.ssid) console.log(`   SSID: ${wifiInfo.ssid}`);
  if (wifiInfo.bssid) console.log(`   BSSID: ${wifiInfo.bssid}`);
  if (wifiInfo.mac) console.log(`   MAC: ${wifiInfo.mac}`);
  if (wifiInfo.ip) console.log(`   IP/Gateway: ${wifiInfo.ip}`);
  if (wifiInfo.linkLocalIPv6) console.log(`   Link-local IPv6: ${wifiInfo.linkLocalIPv6}`);
  if (!wifiInfo.ssid && !wifiInfo.bssid && !wifiInfo.ip) {
    console.log(`   Không tìm thấy thông tin WiFi`);
  }
});

module.exports = app;
