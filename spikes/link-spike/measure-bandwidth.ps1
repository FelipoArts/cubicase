# Mede o trafego da placa de rede durante uma sessao de jogo (Fase 0 do plano P2P).
# Uso (no PC do HOST, com o servidor rodando e N convidados jogando):
#   .\measure-bandwidth.ps1 -Guests 2 -Seconds 300
# Feche navegadores/streaming/downloads antes, para o numero refletir so o Minecraft.
param(
  [int]$Guests = 1,
  [int]$Seconds = 300,
  [string]$Adapter = ""
)
if (-not $Adapter) {
  $Adapter = (Get-NetAdapter | Where-Object Status -eq "Up" | Sort-Object LinkSpeed -Descending | Select-Object -First 1).Name
}
Write-Host "Placa: $Adapter | Convidados: $Guests | Duracao: $Seconds s (amostra a cada 5 s)"
$prev = Get-NetAdapterStatistics -Name $Adapter
$rows = @()
for ($t = 5; $t -le $Seconds; $t += 5) {
  Start-Sleep -Seconds 5
  $cur = Get-NetAdapterStatistics -Name $Adapter
  $up = ($cur.SentBytes - $prev.SentBytes) / 5 / 1KB
  $down = ($cur.ReceivedBytes - $prev.ReceivedBytes) / 5 / 1KB
  $rows += [pscustomobject]@{ T = $t; UpKBs = [math]::Round($up, 1); DownKBs = [math]::Round($down, 1) }
  Write-Host ("{0,4}s  envio {1,8:N1} KB/s   recebimento {2,8:N1} KB/s" -f $t, $up, $down)
  $prev = $cur
}
$avgUp = ($rows | Measure-Object UpKBs -Average).Average
$maxUp = ($rows | Measure-Object UpKBs -Maximum).Maximum
$avgDown = ($rows | Measure-Object DownKBs -Average).Average
Write-Host ""
Write-Host "=== RESUMO ==="
Write-Host ("Envio medio: {0:N1} KB/s (pico {1:N1})  -> por convidado: {2:N1} KB/s" -f $avgUp, $maxUp, ($avgUp / $Guests))
Write-Host ("Recebimento medio: {0:N1} KB/s -> por convidado: {1:N1} KB/s" -f $avgDown, ($avgDown / $Guests))
Write-Host ("Soma dos dois sentidos por convidado: {0:N1} KB/s  (estimativa do plano: 35 KB/s)" -f (($avgUp + $avgDown) / $Guests))
$rows | Export-Csv -NoTypeInformation -Path "bandwidth-$(Get-Date -Format yyyyMMdd-HHmmss).csv"
