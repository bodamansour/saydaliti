// The look of the website's new design (src/style.css): the deep green of a pharmacy sign, one accent
// green, amber and red only for warnings; Noto Kufi Arabic for titles, Readex Pro for text and numbers.
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
    paper: Color(0xFFF2F5F1),
    surface: Color(0xFFFFFFFF),
    sunk: Color(0xFFE8EEE8),
    line: Color(0xFFD8E0D9),
    fg: Color(0xFF10241C),
    muted: Color(0xFF4C5F55),
    faint: Color(0xFF6C7E74),
    rail: Color(0xFF0B3B2E),
    railFg: Color(0xFFECF5F0),
    railMuted: Color(0xFFA8C4B7),
    accent: Color(0xFF0D7A56),
    accentStrong: Color(0xFF0A6346),
    accentSoft: Color(0xFFDFF0E7),
    onAccent: Color(0xFFFFFFFF),
    crit: Color(0xFFB3261E),
    critSoft: Color(0xFFFBE8E6),
    warn: Color(0xFFA35C05),
    warnSoft: Color(0xFFFBEFD8),
    info: Color(0xFF3E6A88),
    infoSoft: Color(0xFFE3EDF3),
  );

  static const dark = Tones(
    paper: Color(0xFF0C1511),
    surface: Color(0xFF13201A),
    sunk: Color(0xFF192820),
    line: Color(0xFF23362C),
    fg: Color(0xFFE5EEE9),
    muted: Color(0xFFA0B4A9),
    faint: Color(0xFF7A8E83),
    rail: Color(0xFF07110D),
    railFg: Color(0xFFE5EEE9),
    railMuted: Color(0xFF8AA597),
    accent: Color(0xFF3CC48A),
    accentStrong: Color(0xFF6BD8A8),
    accentSoft: Color(0xFF11352A),
    onAccent: Color(0xFF03140C),
    crit: Color(0xFFFF8A80),
    critSoft: Color(0xFF3A1A18),
    warn: Color(0xFFF2B65C),
    warnSoft: Color(0xFF35270F),
    info: Color(0xFF8DB8D8),
    infoSoft: Color(0xFF172A35),
  );

  @override
  Tones copyWith() => this;

  @override
  Tones lerp(ThemeExtension<Tones>? other, double t) => t < .5 ? this : (other as Tones? ?? this);
}

extension TonesOf on BuildContext {
  Tones get tones => Theme.of(this).extension<Tones>()!;
}

const textFont = 'Readex Pro';
const signFont = 'Noto Kufi Arabic';

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
    ),
    cardTheme: CardThemeData(
      color: t.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: t.line)),
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
