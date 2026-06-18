// Ortho-quad vertex for the coverage prepare pass.  Renders a full-tile quad
// into the cached per-tile RT.  v_pos is the tile-relative [0,1] position with
// NO DEM-border epsilon, matching the live point_hillshade.vertex convention
// (v_pos = a_pos / 8192) so the baked field samples the derivative FBO exactly
// where the composite later samples the RT.
uniform mat4 u_matrix;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_texture_pos;

out vec2 v_pos;

void main() {
    gl_Position = u_matrix * vec4(a_pos, 0, 1);
    v_pos = a_texture_pos / 8192.0;
}
