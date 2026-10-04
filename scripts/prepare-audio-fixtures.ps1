$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixtureRoot = Join-Path $PSScriptRoot '../artifacts/product-gaps-20261004/audio-inputs/workspace'
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetFullPath($fixtureRoot)) | Out-Null
$speechSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$audioFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voiceNames = @($speechSynth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$englishVoice = $speechSynth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
if (-not $englishVoice) { throw 'A local English test voice is unavailable' }
$speechSynth.SelectVoice($englishVoice.VoiceInfo.Name)
$speechSynth.SetOutputToWaveFile((Join-Path $fixtureRoot 'beijing-english.wav'), $audioFormat)
$speechSynth.Speak('Please download the satellite imagery for Beijing. Use zoom level twelve and save it as a Geo TIFF file.')
$speechSynth.SetOutputToNull()
$chineseVoice = $speechSynth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
if ($chineseVoice) {
    $speechSynth.SelectVoice($chineseVoice.VoiceInfo.Name)
    $speechSynth.SetOutputToWaveFile((Join-Path $fixtureRoot 'beijing-chinese.wav'), $audioFormat)
    $speechSynth.Speak('请下载北京市的卫星影像，缩放级别设为十二，保存到当前工作区。')
    $speechSynth.SetOutputToNull()
}
$speechSynth.Dispose()
@{ generated = $true; voices = $voiceNames; chinese = [bool]$chineseVoice } | ConvertTo-Json -Compress
