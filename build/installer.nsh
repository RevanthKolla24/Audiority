; System DPI awareness prevents Windows bitmap-scaling the entire installer.
; Do not claim per-monitor awareness: the stock NSIS dialogs/plugins need native
; multi-monitor validation before making that stronger promise.
ManifestDPIAware true

!macro customHeader
  WindowIcon on
  SetFont "Segoe UI" 10
  BrandingText "Audiority · Local media processing"
!macroend