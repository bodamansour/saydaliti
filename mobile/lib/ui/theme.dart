// The look of the website (src/style.css): white surfaces, one royal blue, a blue-to-cyan gradient for the
// one thing that matters most, amber and red only for warnings; Cairo for titles, text and numbers.
import 'package:flutter/material.dart';

class Tones extends ThemeExtension<Tones> {
  final Color paper, surface, sunk, line, fg, muted, faint, rail, railFg, railMuted, accent, accentStrong, accentSoft, onAccent, crit, critSoft, warn, warnSoft, info, infoSoft;
  const Tones({
    required this.paper,
    required this.surface,
    required this.sunk,
    required this.line,
    required this.fg,
    required this.muted,
    required this.faint,
    required this.rail,
    required this.railFg,
    required this.railMuted,
    required this.accent,
    required this.accentStrong,
    required this.accentSoft,
    required this.onAccent,
    required this.crit,
    required this.critSoft,
    required this.warn,
    required this.warnSoft,
    required this.info,
    required this.infoSoft,
  });

  static const light = Tones(
    paper: Color(0xFFF7F8FA),
    surface: Color(0xFFFFFFFF),
    sunk: Color(0xFFEEF1F6),
    line: Color(0xFFE6E8EE),
    fg: Color(0xFF0B1220),
    muted: Color(0xFF566074),
    faint: Color(0xFF717B8F),
    rail: Color(0xFFFFFFFF),
    railFg: Color(0xFF0B1220),
    railMuted: Color(0xFF566074),
    accent: Color(0xFF1746D1),
    accentStrong: Color(0xFF1239AD),
    accentSoft: Color(0xFFE9EEFF),
    onAccent: Color(0xFFFFFFFF),
    crit: Color(0xFFC81E1E),
    critSoft: Color(0xFFFEE2E2),
    warn: Color(0xFFA94E08),
    warnSoft: Color(0xFFFEF3C7),
    info: Color(0xFF0E7490),
    infoSoft: Color(0xFFCFFAFE),
  );

  static const dark = Tones(
    paper: Color(0xFF0A0F1D),
    surface: Color(0xFF111A2E),
    sunk: Color(0xFF17223A),
    line: Color(0xFF222E49),
    fg: Color(0xFFE6EBF5),
    muted: Color(0xFF9EAAC2),
    faint: Color(0xFF76839D),
    rail: Color(0xFF0E1526),
    railFg: Color(0xFFE6EBF5),
    railMuted: Color(0xFF9EAAC2),
    accent: Color(0xFF6F95FF),
    accentStrong: Color(0xFF9BB5FF),
    accentSoft: Color(0xFF18285A),
    onAccent: Color(0xFF05102E),
    crit: Color(0xFFFF8A80),
    critSoft: Color(0xFF3D1717),
    warn: Color(0xFFF5B558),
    warnSoft: Color(0xFF3A2A0C),
    info: Color(0xFF67D8EC),
    infoSoft: Color(0xFF0C2F38),
  );

  bool get isDark => paper.computeLuminance() < .2;

  /// Blue to cyan: for the one number that matters most on a screen, and the sign-in page.
  LinearGradient get hero => LinearGradient(
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
        colors: isDark ? const [Color(0xFF2452E0), Color(0xFF0891B2)] : const [Color(0xFF1746D1), Color(0xFF06B6D4)],
      );

  @override
  Tones copyWith() => this;

  @override
  Tones lerp(ThemeExtension<Tones>? other, double t) => t < .5 ? this : (other as Tones? ?? this);
}

extension TonesOf on BuildContext {
  Tones get tones => Theme.of(this).extension<Tones>()!;
}

const textFont = 'Cairo';
const signFont = 'Cairo';

ThemeData buildTheme(Brightness b) {
  final t = b == Brightness.dark ? Tones.dark : Tones.light;
  final scheme = ColorScheme(
    brightness: b,
    primary: t.accent,
    onPrimary: t.onAccent,
    secondary: t.accentStrong,
    onSecondary: t.onAccent,
    error: t.crit,
    onError: b == Brightness.dark ? const Color(0xFF1A0605) : Colors.white,
    surface: t.surface,
    onSurface: t.fg,
    surfaceContainerHighest: t.sunk,
    outline: t.line,
    outlineVariant: t.line,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: b, fontFamily: textFont);
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(12));
  return base.copyWith(
    scaffoldBackgroundColor: t.paper,
    extensions: [t],
    textTheme: base.textTheme.apply(bodyColor: t.fg, displayColor: t.fg).copyWith(
          headlineSmall: TextStyle(fontFamily: signFont, fontWeight: FontWeight.w700, fontSize: 22, color: t.fg, height: 1.45),
          titleLarge: TextStyle(fontFamily: signFont, fontWeight: FontWeight.w700, fontSize: 19, color: t.fg, height: 1.45),
          titleMedium: TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600, fontSize: 16, color: t.fg, height: 1.5),
          bodyMedium: TextStyle(fontFamily: textFont, fontSize: 15, color: t.fg, height: 1.6),
          bodySmall: TextStyle(fontFamily: textFont, fontSize: 13, color: t.muted, height: 1.5),
          labelLarge: const TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600, fontSize: 15),
        ),
    appBarTheme: AppBarTheme(
      backgroundColor: t.rail,
      foregroundColor: t.railFg,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(fontFamily: signFont, fontWeight: FontWeight.w700, fontSize: 18, color: t.railFg),
      surfaceTintColor: Colors.transparent,
      scrolledUnderElevation: 0,
      shape: Border(bottom: BorderSide(color: t.line)),
    ),
    cardTheme: CardThemeData(
      color: t.surface,
      elevation: b == Brightness.dark ? 0 : 1,
      shadowColor: const Color(0x260B1220),
      surfaceTintColor: Colors.transparent,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: t.line)),
    ),
    dividerTheme: DividerThemeData(color: t.line, space: 1, thickness: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(backgroundColor: t.accent, foregroundColor: t.onAccent, minimumSize: const Size(48, 48), shape: shape, textStyle: const TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600, fontSize: 15)),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(foregroundColor: t.fg, minimumSize: const Size(48, 48), shape: shape, side: BorderSide(color: t.line), textStyle: const TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600, fontSize: 15)),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: t.accentStrong, textStyle: const TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: t.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.line)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.line)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.accent, width: 2)),
      labelStyle: TextStyle(color: t.muted),
      hintStyle: TextStyle(color: t.faint),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: t.surface,
      indicatorColor: t.accentSoft,
      surfaceTintColor: Colors.transparent,
      height: 66,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(
          fontFamily: textFont, fontSize: 12.5, fontWeight: s.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w400, color: s.contains(WidgetState.selected) ? t.accentStrong : t.muted)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? t.accentStrong : t.muted)),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: t.surface,
      selectedColor: t.accentSoft,
      side: BorderSide(color: t.line),
      labelStyle: TextStyle(fontFamily: textFont, color: t.fg, fontSize: 14),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      showCheckmark: false,
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? t.accentSoft : t.surface),
        foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? t.accentStrong : t.fg),
        side: WidgetStatePropertyAll(BorderSide(color: t.line)),
        textStyle: const WidgetStatePropertyAll(TextStyle(fontFamily: textFont, fontWeight: FontWeight.w600, fontSize: 14)),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: t.surface, surfaceTintColor: Colors.transparent, showDragHandle: true),
    dialogTheme: DialogThemeData(backgroundColor: t.surface, surfaceTintColor: Colors.transparent),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: t.fg, contentTextStyle: TextStyle(fontFamily: textFont, color: t.paper)),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: t.accent),
  );
}
