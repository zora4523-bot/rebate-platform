// SVG 1.1 colour keywords (SVG 1.1 §4.4, the same 147 names CSS Color 3 defines). A keyword in
// this list means the same colour in a CSS declaration and in an SVG presentation attribute.
export const NAMED_COLORS: ReadonlySet<string> = new Set(
  `
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
  mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna
  silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato
  turquoise violet wheat white whitesmoke yellow yellowgreen
`
    .trim()
    .split(/\s+/),
);
